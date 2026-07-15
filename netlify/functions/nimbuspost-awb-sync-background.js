/**
 * Netlify Function: nimbuspost-awb-sync
 * Scheduled: every 15 minutes (see netlify.toml)
 * Manual:    POST with X-Admin-Key header
 *
 * The Problem We're Solving:
 * Orders pushed to the NimbusPost panel WITHOUT an AWB (the "Push to NimbusPost
 * Panel (No AWB)" flow) get their courier + AWB assigned later INSIDE NimbusPost.
 * NimbusPost's status webhook only carries the AWB — not the order number — so it
 * can't link that first AWB back to our order. The order stays "unshipped" in our
 * panel and the customer never gets a shipped notification.
 *
 * The Fix:
 * Poll NimbusPost's orders panel, match each NimbusPost order to ours by
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

const NP_ORDERS_URL = 'https://ship.nimbuspost.com/api/orders';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

// Orders eligible to be flipped to "shipped" once an AWB appears.
const UNSHIPPED_STATUSES = ['paid', 'confirmed', 'cod_pending', 'partial_cod_pending', 'replacement_pending'];

const NP_MAX_PAGE   = 50;   // NimbusPost rejects page > 50
const NP_SCAN_PAGES = 5;    // newest pages only — keeps total calls well under the function timeout
const NOTIFY_LIMIT  = 60;   // cap notifications per run (safety)

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

function paginationFromResponse(payload) {
  const sources = [payload?.data, payload?.meta, payload?.pagination, payload];
  for (const source of sources) {
    if (!source || Array.isArray(source) || typeof source !== 'object') continue;
    const current = Number(source.current_page || source.page || 0);
    const last = Number(source.last_page || source.total_pages || source.pages || 0);
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

// Candidate listing endpoints — NimbusPost exposes orders/shipments under a few
// paths depending on the account. We probe page 1 of each to find the one that
// returns rows, then scan only that endpoint (keeps us well under the timeout).
const NP_LIST_ENDPOINTS = [
  { url: 'https://ship.nimbuspost.com/api/orders',       params: {} },
  { url: 'https://ship.nimbuspost.com/api/shipping/all', params: { ship_status: 'booked' } },
  { url: 'https://ship.nimbuspost.com/api/shipments',    params: {} },
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
  url.searchParams.set('limit', '50');
  url.searchParams.set('per_page', '50');
  url.searchParams.set('sort', 'desc');
  url.searchParams.set('sort_by', 'id');
  for (const [k, v] of Object.entries(endpoint.params)) url.searchParams.set(k, v);
  return url;
}

function collectRows(payload, map) {
  let added = 0;
  for (const row of orderRowsFromResponse(payload)) {
    const num = orderNumberFromRow(row);
    const awb = awbFromRow(row);
    if (num && awb) {
      if (!map.has(num)) map.set(num, { awb, courier: courierFromRow(row) });
      added++;
    }
  }
  return added;
}

// Returns { map, diag }. Phase 1: probe page 1 of each endpoint. Phase 2: scan a
// few more pages of whichever endpoint returned usable rows.
async function fetchNimbusAwbMap(apiKey) {
  const map = new Map();
  const diag = [];
  let working = null;

  // ── Phase 1: discovery (≤3 calls) ──
  for (const endpoint of NP_LIST_ENDPOINTS) {
    try {
      const { response, payload, snippet } = await npGet(buildListUrl(endpoint, 1), apiKey);
      const rows = orderRowsFromResponse(payload);
      const firstKeys = rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]).slice(0, 12).join(',') : '';
      diag.push(`${endpoint.url} → HTTP ${response.status}, rows:${rows.length}${firstKeys ? `, keys:[${firstKeys}]` : `, body:${snippet}`}`);
      if (response.ok && rows.length) {
        const added = collectRows(payload, map);
        if (added > 0) { working = endpoint; break; }
      }
    } catch (err) {
      diag.push(`${endpoint.url} → ${err.name === 'AbortError' ? 'timeout' : 'error: ' + err.message}`);
    }
  }

  // ── Phase 2: scan a few more pages of the working endpoint ──
  if (working) {
    const lastPage = Math.min(NP_SCAN_PAGES, NP_MAX_PAGE);
    for (let page = 2; page <= lastPage; page++) {
      try {
        const { response, payload } = await npGet(buildListUrl(working, page), apiKey);
        if (!response.ok) break;
        const rows = orderRowsFromResponse(payload);
        collectRows(payload, map);
        if (rows.length < 50) break;
      } catch (_) { break; }
    }
  }

  return { map, diag };
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
      params: [firstName, bookList, courier || 'Courier', awb, trackUrl],
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
  const summary = { scanned: awbMap.size, matched: 0, synced: 0, notified: 0, errors: [], diag };
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

    try {
      const update = {
        status:       'shipped',
        tracking_id:  hit.awb,
        tracking_url: npTrackUrl(hit.awb),
        shipped_at:   new Date().toISOString(),
      };
      if (hit.courier) update.courier_name = hit.courier;

      await supabase.from('orders').update(update).eq('id', order.id);
      summary.synced++;
      Object.assign(order, update);

      if (summary.notified < NOTIFY_LIMIT) {
        await notifyShipped(order, hit.awb, hit.courier);
        summary.notified++;
      }
    } catch (err) {
      summary.errors.push(`${order.razorpay_order_id || order.id}: ${String(err.message || err).slice(0, 180)}`);
    }
  }

  console.log('[awb-sync]', JSON.stringify(summary));
  return summary;
}

// ── Handler (scheduled + manual) ─────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // Manual trigger from the admin panel
  if (event.httpMethod === 'POST') {
  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
    try {
      const summary = await runSync();
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, summary }) };
    } catch (err) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
  }

  // Scheduled invocation (no HTTP auth)
  try {
    await runSync();
  } catch (err) {
    console.error('[awb-sync] scheduled run failed:', err.message);
  }
  return { statusCode: 200, headers: CORS, body: 'OK' };
};
