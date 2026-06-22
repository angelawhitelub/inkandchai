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

const NP_ORDERS_URL = 'https://ship.nimbuspost.com/api/orders';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

// Orders eligible to be flipped to "shipped" once an AWB appears.
const UNSHIPPED_STATUSES = ['paid', 'confirmed', 'cod_pending', 'partial_cod_pending'];

const NP_MAX_PAGE   = 50;   // NimbusPost rejects page > 50
const NP_SCAN_PAGES = 10;   // newest pages only — recent shipments are what we sync
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
  return String(
    row?.courier_name || row?.courier?.name || row?.courier ||
    row?.shipment?.courier_name || ''
  ).trim();
}

function orderNumberFromRow(row) {
  return normalizeOrderNumber(
    row?.order_number || row?.order_no || row?.channel_order_id ||
    row?.channel_order_number || row?.order_reference ||
    row?.order?.order_number || row?.order_id
  );
}

// Build a map: order_number → { awb, courier } from NimbusPost's recent panel orders.
async function fetchNimbusAwbMap(apiKey) {
  const map = new Map();
  const lastPage = Math.min(NP_SCAN_PAGES, NP_MAX_PAGE);

  for (let page = 1; page <= lastPage; page++) {
    const url = new URL(NP_ORDERS_URL);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', '100');
    url.searchParams.set('sort', 'desc');     // newest first (lowercase — NimbusPost requirement)
    url.searchParams.set('sort_by', 'id');

    let response, payload;
    try {
      response = await fetch(url, { headers: { 'Accept': 'application/json', 'NP-API-KEY': apiKey } });
      const text = await response.text();
      try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = { message: text }; }
    } catch (err) {
      // Network/timeout — stop with whatever we have rather than failing the run.
      console.warn('[awb-sync] fetch error, stopping scan:', err.message);
      break;
    }

    if (!response.ok || payload.status === false || payload.success === false || payload.error) {
      const msg = JSON.stringify(payload).toLowerCase();
      if (response.status === 404 && /(page|sort).*(must|one of|less than)/.test(msg)) break;
      // Unknown error — stop gracefully with what we've gathered.
      console.warn(`[awb-sync] orders API ${response.status}:`, msg.slice(0, 200));
      break;
    }

    const rows = orderRowsFromResponse(payload);
    for (const row of rows) {
      const num = orderNumberFromRow(row);
      const awb = awbFromRow(row);
      if (num && awb && !map.has(num)) map.set(num, { awb, courier: courierFromRow(row) });
    }

    const pagination = paginationFromResponse(payload);
    if (!rows.length) break;
    if (pagination.last ? page >= pagination.last : rows.length < 100) break;
  }

  return map;
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

  const awbMap = await fetchNimbusAwbMap(apiKey);
  const summary = { scanned: awbMap.size, matched: 0, synced: 0, notified: 0, errors: [] };
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
    const adminKey = process.env.ADMIN_SECRET;
    const sentKey  = event.headers['x-admin-key'] || event.headers['X-Admin-Key'];
    if (adminKey && sentKey !== adminKey) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
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
