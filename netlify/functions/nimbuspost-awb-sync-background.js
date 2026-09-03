/**
 * Netlify Function: nimbuspost-awb-sync
 * Invoked every 3 minutes by nimbuspost-awb-sync-scheduled.
 * Manual: POST with authenticated admin headers.
 *
 * The Problem We're Solving:
 * Orders pushed to the NimbusPost panel WITHOUT an AWB (the "Push to NimbusPost
 * Panel (No AWB)" flow) get their courier + AWB assigned later INSIDE NimbusPost.
 * NimbusPost's status webhook only carries the AWB — not the order number — so it
 * can't link that first AWB back to our order. The order stays "unshipped" in our
 * panel and the customer never gets a shipped notification.
 *
 * The Fix:
 * Poll NimbusPost's shipments feed, match each NimbusPost shipment to ours by
 * order_number (the IC-… id we sent), and when NimbusPost has assigned an AWB,
 * write it back: tracking_id + courier + tracking_url + status='shipped', then
 * fire the same shipped notification the webhook sends. Once tracking_id is set,
 * the existing webhook takes over for out-for-delivery / delivered events.
 *
 * Required env vars:
 *   NIMBUSPOST_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_SECRET
 *   WHATSAPP_TOKEN / WHATSAPP_PHONE_ID (for WhatsApp), Brevo/Resend keys (email)
 */

const { createClient } = require('@supabase/supabase-js');
const { sendWhatsApp } = require('./utils/whatsapp');
const { sendEmail }    = require('./utils/email');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

// Orders eligible to be flipped to "shipped" once an AWB appears.
const UNSHIPPED_STATUSES = ['paid', 'confirmed', 'cod_pending', 'partial_cod_pending', 'replacement_pending'];

// Orders whose AWB may legitimately be REPLACED by a newer one.
//
// 'cancelled' is the case this exists for: the courier cancels a shipment, the
// order is re-shipped by hand in the NimbusPost panel, and a second AWB is
// created. Nothing told us — the webhook finds orders by tracking_id, and the
// tracking_id we hold is the dead one — so the customer kept a tracking link
// that goes nowhere.
//
// A newer AWB in the panel is itself the authorisation: nobody creates a
// shipment for an order they did not mean to re-ship.
const RESHIPPABLE_STATUSES = [
  'cancelled', 'shipped', 'paid', 'confirmed',
  'cod_pending', 'partial_cod_pending', 'replacement_pending',
];

// A new AWB against one of these is never acted on automatically.
//
// The money ones are the point: 34 of the 53 courier-cancelled orders in the
// last 60 days had ALREADY been refunded. Re-shipping one of those means
// sending books we have been paid nothing for, and telling the customer their
// refunded order is on its way. 'delivered' and 'rto' are here because a new
// AWB on a finished shipment is a return leg, not a re-ship.
const REVIEW_ONLY_STATUSES = [
  'refunded', 'partially_refunded', 'refund_pending', 'refund_failed',
  'delivered', 'rto', 'lost', 'undelivered',
];

const NP_MAX_PAGE   = 50;   // NimbusPost rejects page > 50
const NP_PAGE_SIZE  = 200;  // accepted by /api/shipments; 500 is rejected
const NOTIFY_LIMIT  = 60;   // cap synced orders + notifications per run (safety)

// ── helpers ──────────────────────────────────────────────────────────────────
function normalizeOrderNumber(value) {
  return String(value ?? '').trim().toUpperCase();
}

function npTrackUrl(awb) {
  return `https://ship.nimbuspost.com/shipping/tracking/${awb}`;
}

function orderRowsFromResponse(payload) {
  const candidates = [
    payload?.data?.data, payload?.data?.orders, payload?.data,
    payload?.orders, payload?.results, payload,
  ];
  return candidates.find(Array.isArray) || [];
}

function paginationFromResponse(payload, pageSize = NP_PAGE_SIZE) {
  const sources = [payload?.data, payload?.meta, payload?.pagination, payload];
  for (const source of sources) {
    if (!source || Array.isArray(source) || typeof source !== 'object') continue;
    const current = Number(source.current_page || source.page || 0);
    const last = Number(source.last_page || source.total_pages || source.pages || 0)
      || (Number(source.count || source.total || 0) > 0
        ? Math.ceil(Number(source.count || source.total) / pageSize)
        : 0);
    if (current || last) return { current, last };
  }
  return { current: 0, last: 0 };
}

function awbFromRow(row) {
  return String(
    row?.awb_number || row?.awb || row?.tracking_number ||
    row?.shipment?.awb_number || row?.shipment?.awb || ''
  ).trim();
}

function courierFromRow(row) {
  if (!row || typeof row !== 'object') return '';
  // NimbusPost / aggregator panel rows label the courier under many different
  // keys depending on the endpoint (Shadowfax, Delhivery, DTDC, Xpressbees…).
  // Check them all so the "Courier" line in the shipped email/WhatsApp shows the
  // REAL courier instead of falling back to a generic label.
  const candidates = [
    row.courier_name, row.courier?.name, row.courier,
    row.shipment?.courier_name, row.shipment?.courier?.name, row.shipment?.courier,
    row.carrier_name, row.carrier?.name, row.carrier,
    row.courier_partner, row.courier_partner_name, row.courier_company,
    row.courier_provider, row.shipping_partner, row.logistic_name, row.provider,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    const s = String(c).trim();
    // Skip empties and bare numeric ids (a courier_id is not a display name).
    if (!s || /^\d+$/.test(s)) continue;
    return s;
  }
  return '';
}

function orderNumberFromRow(row) {
  return normalizeOrderNumber(
    row?.order_number || row?.order_no || row?.channel_order_id ||
    row?.channel_order_number || row?.order_reference ||
    row?.order?.order_number || row?.order_id
  );
}

// AWBs belong to shipment rows. /api/orders is the draft/panel-order feed and
// may contain a few AWBs, but stopping on it hid real shipments on pages 6–7.
// Keep a fallback for older NimbusPost accounts, but always prefer shipments.
const NP_LIST_ENDPOINTS = [
  { url: 'https://ship.nimbuspost.com/api/shipments',    params: {} },
  { url: 'https://ship.nimbuspost.com/api/orders',       params: {} },
];

// fetch with a hard per-call timeout so one slow call can't kill the function.
async function npGet(url, apiKey, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json', 'NP-API-KEY': apiKey },
      signal: ctrl.signal,
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = { message: text }; }
    return { response, payload, snippet: text.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

function buildListUrl(endpoint, page) {
  const url = new URL(endpoint.url);
  url.searchParams.set('page', String(page));
  url.searchParams.set('limit', String(NP_PAGE_SIZE));
  url.searchParams.set('per_page', String(NP_PAGE_SIZE));
  url.searchParams.set('sort', 'desc');
  url.searchParams.set('sort_by', 'id');
  for (const [k, v] of Object.entries(endpoint.params)) url.searchParams.set(k, v);
  return url;
}

/** 'YYYY-MM-DD' the shipment was created in the panel, or '' if absent. */
function rowCreated(row) {
  const v = String(row?.created || row?.created_at || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

/** NimbusPost's own row id, used only to tell newer shipments from older ones. */
function rowSeq(row) {
  const n = Number(row?.id ?? row?.shipment_id ?? row?.shipment?.id ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function collectRows(payload, map) {
  let added = 0;
  for (const row of orderRowsFromResponse(payload)) {
    const num = orderNumberFromRow(row);
    const awb = awbFromRow(row);
    if (!num || !awb) continue;
    added++;
    const seq = rowSeq(row);
    const prev = map.get(num);
    // An order can have SEVERAL shipments: the courier cancels one, it gets
    // re-shipped in the panel, and both rows come back. The newest is the live
    // one. This used to keep whichever row arrived first and rely on the feed
    // being sorted, which is not a guarantee worth a customer's tracking link.
    if (!prev || seq > prev.seq) map.set(num, { awb, courier: courierFromRow(row), seq, created: rowCreated(row) });
  }
  return added;
}

// Returns { map, diag }. Probe the shipment feed first, then scan every page it
// reports (currently ~8 requests for the whole account). This is both faster
// and complete compared with five 50-row pages from /api/orders.
async function fetchNimbusAwbMap(apiKey) {
  const map = new Map();
  const diag = [];
  let working = null;
  let firstPayload = null;

  // ── Phase 1: discovery (≤3 calls) ──
  for (const endpoint of NP_LIST_ENDPOINTS) {
    try {
      const { response, payload, snippet } = await npGet(buildListUrl(endpoint, 1), apiKey);
      const rows = orderRowsFromResponse(payload);
      const firstKeys = rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]).slice(0, 12).join(',') : '';
      diag.push(`${endpoint.url} → HTTP ${response.status}, rows:${rows.length}${firstKeys ? `, keys:[${firstKeys}]` : `, body:${snippet}`}`);
      if (response.ok && rows.length) {
        const added = collectRows(payload, map);
        if (added > 0) { working = endpoint; firstPayload = payload; break; }
      }
    } catch (err) {
      diag.push(`${endpoint.url} → ${err.name === 'AbortError' ? 'timeout' : 'error: ' + err.message}`);
    }
  }

  // ── Phase 2: scan every reported page of the working endpoint ──
  if (working) {
    let lastPage = NP_MAX_PAGE;
    const pagination = paginationFromResponse(firstPayload);
    if (pagination.last) lastPage = Math.min(pagination.last, NP_MAX_PAGE);
    for (let page = 2; page <= lastPage; page++) {
      try {
        const { response, payload } = await npGet(buildListUrl(working, page), apiKey);
        if (!response.ok) break;
        const rows = orderRowsFromResponse(payload);
        collectRows(payload, map);
        if (rows.length < NP_PAGE_SIZE) break;
      } catch (_) { break; }
    }
  }

  return { map, diag };
}

/**
 * Write an order update, dropping optional bookkeeping columns the database
 * does not have yet. PostgREST names the offending column, so the rest of the
 * write still lands — a re-ship must not fail to record because
 * sql/orders_previous_awbs.sql has not been run.
 */
async function updateOrderTolerant(supabase, orderId, patch) {
  const fields = { ...patch };
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, error } = await supabase.from('orders').update(fields).eq('id', orderId).select('id');
    if (!error) {
      if (!data || !data.length) return { ok: false, error: 'update matched no order row' };
      return { ok: true, applied: fields };
    }
    const msg = error.message || '';
    // Longest match first: several column names share a prefix.
    const missing = Object.keys(fields).filter(k => msg.includes(k)).sort((a, b) => b.length - a.length)[0];
    if (!missing) return { ok: false, error: msg };
    delete fields[missing];
    if (!Object.keys(fields).length) return { ok: false, error: msg };
  }
  return { ok: false, error: 'too many unknown columns' };
}

/** Append an AWB to the audit trail of AWBs this order has already carried. */
function appendPreviousAwb(existing, awb) {
  const seen = String(existing || '').split(',').map(s => s.trim()).filter(Boolean);
  if (awb && !seen.includes(awb)) seen.push(awb);
  return seen.join(',').slice(0, 500);
}

/**
 * The order was re-shipped in the NimbusPost panel and now carries a different
 * AWB. Move our record onto it, and reset everything that described the DEAD
 * shipment — the last courier status, the movement stamps, the cancellation.
 *
 * Leaving those behind is not cosmetic: auto-cancel-stale-cod and the in-transit
 * notifier both read them, and a fresh shipment wearing the old shipment's
 * "cancelled" status would be cancelled all over again.
 */
function reshipPatch(order, hit, now) {
  return {
    status:       'shipped',
    tracking_id:  hit.awb,
    tracking_url: npTrackUrl(hit.awb),
    courier_name: hit.courier || order.courier_name || null,
    shipped_at:   now,
    awb_assigned_at: now,
    // Stamps that belonged to the AWB we just replaced.
    last_nimbuspost_status:    null,
    last_nimbuspost_event_at:  null,
    shipment_moved_at:         null,
    in_transit_notified_at:    null,
    // It is not cancelled any more.
    cancelled_at:              null,
    cancellation_source:       null,
    cancellation_reason:       null,
    nimbuspost_auto_cancelled: false,
    auto_cancelled_at:         null,
    auto_cancel_claimed_at:    null,
    previous_tracking_ids: appendPreviousAwb(order.previous_tracking_ids, order.tracking_id),
  };
}

// A re-ship older than this gets its tracking corrected silently. Telling
// someone their order "has shipped" weeks after they received it reads as a
// broken system, and the tracking link is what actually needed fixing.
const RESHIP_NOTIFY_MAX_AGE_DAYS = 7;

function reshipIsRecent(created, now = Date.now()) {
  if (!created) return true;   // no date from the panel: assume it is current
  const t = Date.parse(created + 'T00:00:00Z');
  if (!Number.isFinite(t)) return true;
  return (now - t) <= RESHIP_NOTIFY_MAX_AGE_DAYS * 86400000;
}

/**
 * Second pass: orders that ALREADY have an AWB, for which NimbusPost now holds
 * a different one.
 *
 * The first pass can never see these — it filters on tracking_id IS NULL — so
 * before this a re-shipped order kept its dead tracking link for good.
 */
async function syncReassignedAwbs(supabase, awbMap, summary) {
  const since = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
  // PostgREST caps a single response at 1000 rows whatever .limit() says, and
  // 'delivered' alone is over 500 in two months — so page, or the oldest
  // re-shipped orders are simply never looked at.
  const orders = [];
  for (let from = 0; from < 6000; from += 1000) {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .in('status', [...RESHIPPABLE_STATUSES, ...REVIEW_ONLY_STATUSES])
      .not('tracking_id', 'is', null)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .range(from, from + 999);
    if (error) throw error;
    orders.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  for (const order of orders) {
    const key = normalizeOrderNumber(order.razorpay_order_id || order.id);
    const hit = awbMap.get(key);
    if (!hit || !hit.awb) continue;
    if (String(hit.awb).trim() === String(order.tracking_id || '').trim()) continue;

    summary.reawb_found++;

    // Never act on an order whose money or delivery is already settled. Report
    // it so a human decides — silence here is how a refunded order gets shipped.
    if (REVIEW_ONLY_STATUSES.includes(order.status)) {
      summary.reawb_needs_review.push({
        order: order.razorpay_order_id || order.id,
        status: order.status,
        old_awb: order.tracking_id,
        new_awb: hit.awb,
      });
      continue;
    }

    if (summary.reawb_updated >= NOTIFY_LIMIT) { summary.deferred++; continue; }

    try {
      const now = new Date().toISOString();
      const patch = reshipPatch(order, hit, now);
      const saved = await updateOrderTolerant(supabase, order.id, patch);
      if (!saved.ok) throw new Error(saved.error);
      summary.reawb_updated++;
      const oldAwb = order.tracking_id;
      Object.assign(order, saved.applied);

      if (reshipIsRecent(hit.created)) {
        await notifyShipped(order, hit.awb, hit.courier);
        summary.reawb_notified++;
      } else {
        summary.reawb_silent++;
      }
      console.log(`[awb-sync] re-shipped ${key}: ${oldAwb} → ${hit.awb} (panel ${hit.created || 'date unknown'})`);
    } catch (err) {
      summary.errors.push(`re-awb ${order.razorpay_order_id || order.id}: ${String(err.message || err).slice(0, 180)}`);
    }
  }
}

// ── Shipped notification (mirrors nimbuspost-webhook.js) ─────────────────────
async function notifyShipped(order, awb, courier) {
  const firstName = (order.customer_name || 'there').split(' ')[0];
  const orderId   = order.razorpay_order_id || order.id;
  const trackUrl  = npTrackUrl(awb);
  const items     = Array.isArray(order.cart_items) ? order.cart_items : [];
  const bookList  = items.map(i => i.title || i.name || '').filter(Boolean).join(', ') || 'your books';
  const isCOD     = ['cod_pending', 'partial_cod_pending'].includes(order.status) || !order.razorpay_payment_id;
  const total     = order.amount_paise ? `₹${(order.amount_paise / 100).toLocaleString('en-IN')}` : '';

  if (order.customer_email) {
    await sendEmail({
      to: order.customer_email,
      subject: `📦 Your Ink & Chai order has been shipped! (${orderId})`,
      html: `
        <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
          <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
          <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:28px;">inkandchai.in</p>
          <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">Your order is on its way! 📦</h2>
          <p style="color:#a09080;line-height:1.8;">Hi ${firstName}, your books have been dispatched.</p>
          <table style="font-size:14px;line-height:1.9;color:#f0e8d8;margin:16px 0;">
            <tr><td style="color:#a09080;padding-right:16px;">Order ID</td><td style="color:#c9a84c;">${orderId}</td></tr>
            <tr><td style="color:#a09080;padding-right:16px;">AWB / Tracking</td><td style="color:#c9a84c;">${awb}</td></tr>
            <tr><td style="color:#a09080;padding-right:16px;">Courier</td><td>${courier || 'Courier'}</td></tr>
            <tr><td style="color:#a09080;padding-right:16px;">Books</td><td>${bookList}</td></tr>
            ${isCOD && total ? `<tr><td style="color:#a09080;padding-right:16px;">Amount due</td><td style="color:#c9a84c;">Please keep ${total} cash ready</td></tr>` : ''}
          </table>
          <a href="${trackUrl}" style="display:inline-block;background:#c9a84c;color:#0d0b08;padding:10px 24px;text-decoration:none;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:600;">Track Order →</a>
          <p style="color:#a09080;font-size:11px;margin-top:12px;">Or copy this link: <span style="color:#c9a84c;">${trackUrl}</span></p>
        </div>`,
    }).catch(e => console.error('[awb-sync] shipped email error:', e.message));
  }

  if (order.customer_phone) {
    await sendWhatsApp({
      to: order.customer_phone,
      template: 'order_shipped',
      // The approved Meta template currently has four body variables.
      params: [firstName, courier || 'Courier', awb, trackUrl],
    }).catch(e => console.error('[awb-sync] shipped WhatsApp error:', e.message));
  }
}

// ── Core ─────────────────────────────────────────────────────────────────────
async function runSync() {
  const apiKey = process.env.NIMBUSPOST_API_KEY;
  if (!apiKey) throw new Error('NIMBUSPOST_API_KEY is not configured in Netlify.');

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { map: awbMap, diag } = await fetchNimbusAwbMap(apiKey);
  const summary = { scanned: awbMap.size, matched: 0, synced: 0, notified: 0, deferred: 0,
                    reawb_found: 0, reawb_updated: 0, reawb_notified: 0, reawb_silent: 0, reawb_needs_review: [],
                    errors: [], diag };
  if (!awbMap.size) return summary;

  // Our orders that are still unshipped and have no AWB yet (last 120 days).
  const since = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
  const { data: orders, error } = await supabase
    .from('orders')
    .select('*')
    .in('status', UNSHIPPED_STATUSES)
    .is('tracking_id', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw error;

  for (const order of orders || []) {
    const key = normalizeOrderNumber(order.razorpay_order_id || order.id);
    const hit = awbMap.get(key);
    if (!hit || !hit.awb) continue;
    summary.matched++;

    // Never sync an order without also sending its shipping notification. Any
    // overflow remains AWB-less and is picked up by the next scheduled run.
    if (summary.synced >= NOTIFY_LIMIT) {
      summary.deferred++;
      continue;
    }

    try {
      const assignedAt = new Date().toISOString();
      const shipmentPaymentType = order.status === 'cod_pending'
        ? 'cod'
        : order.status === 'partial_cod_pending' ? 'partial_cod' : 'prepaid';
      const update = {
        status:       'shipped',
        tracking_id:  hit.awb,
        tracking_url: npTrackUrl(hit.awb),
        shipped_at:   assignedAt,
        awb_assigned_at: assignedAt,
        shipment_payment_type: shipmentPaymentType,
      };
      if (hit.courier) update.courier_name = hit.courier;

      const saved = await supabase.from('orders').update(update).eq('id', order.id).select('id');
      if (saved.error) throw saved.error;
      if (!saved.data?.length) throw new Error('Supabase update matched no order row');
      summary.synced++;
      Object.assign(order, update);

      await notifyShipped(order, hit.awb, hit.courier);
      summary.notified++;
    } catch (err) {
      summary.errors.push(`${order.razorpay_order_id || order.id}: ${String(err.message || err).slice(0, 180)}`);
    }
  }

  // Second pass: orders that already have an AWB and have been re-shipped.
  try {
    await syncReassignedAwbs(supabase, awbMap, summary);
  } catch (err) {
    summary.errors.push(`re-awb pass: ${String(err.message || err).slice(0, 180)}`);
  }

  console.log('[awb-sync]', JSON.stringify(summary));
  return summary;
}

// ── Background worker handler ────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const adminBlock = requireAdmin(event, CORS); if (adminBlock) return adminBlock;

  try {
    const summary = await runSync();
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, summary }) };
  } catch (err) {
    console.error('[awb-sync] worker failed:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

exports._test = {
  normalizeOrderNumber, orderRowsFromResponse, paginationFromResponse,
  awbFromRow, orderNumberFromRow, collectRows, buildListUrl,
  fetchNimbusAwbMap, rowSeq, rowCreated, reshipPatch, appendPreviousAwb, updateOrderTolerant,
  reshipIsRecent,
  RESHIPPABLE_STATUSES, REVIEW_ONLY_STATUSES,
};
