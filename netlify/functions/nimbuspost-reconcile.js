/**
 * Netlify Function: nimbuspost-reconcile
 * POST /.netlify/functions/nimbuspost-reconcile
 *
 * Batch-reconciles shipped orders against NimbusPost's live tracking API.
 * Solves the "stuck at shipped" problem for orders that were already
 * shipped before the webhook was connected.
 *
 * Body options:
 *   { all_shipped: true }       — check ALL orders with status='shipped' OR 'out_for_delivery' (last 90 days)
 *   { awbs: ["AWB1","AWB2"] }  — check specific AWBs
 *   { order_ids: ["IC-..."] }  — check specific order IDs
 *
 * NimbusPost status → our status mapping (same as nimbuspost-webhook.js):
 *   delivered → delivered
 *   out for delivery → out_for_delivery
 *   cancelled / rto → rto
 *   undelivered / ndr → undelivered
 *   others (in transit, etc.) → ignored
 */

const { createClient } = require('@supabase/supabase-js');
const { sendWhatsApp }  = require('./utils/whatsapp');
const { requireAdmin } = require('./utils/admin-auth');

const NP_BASE = 'https://api.nimbuspost.com/v1';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

// ── NimbusPost status → internal status (mirrors nimbuspost-webhook.js) ──────
const STATUS_MAP = {
  'delivered':          'delivered',
  'shipment delivered': 'delivered',
  'delivery done':      'delivered',
  'out for delivery':   'out_for_delivery',
  'out_for_delivery':   'out_for_delivery',
  'rto':                'rto',
  'rto initiated':      'rto',
  'rto in transit':     'rto',
  'rto delivered':      'rto',
  'cancelled':          'rto',
  'undelivered':        'undelivered',
  'ndr':                'undelivered',
  'delivery failed':    'undelivered',
  'lost':               'lost',
};

function normalizeStatus(s) {
  return STATUS_MAP[(s || '').toLowerCase().trim()] || null;
}

// ── NimbusPost helpers ────────────────────────────────────────────────────────
// Partners API docs: https://documenter.getpostman.com/view/9692837/TW6wHnoz
// Login:  POST /v1/users/login  { email, password }  → { token }
// Auth:   Authorization: Bearer {token}  (no x-api-key needed)
async function npFetch(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${NP_BASE}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  return { ok: res.ok, status: res.status, data };
}

async function npAuthenticate() {
  const email    = process.env.NIMBUSPOST_EMAIL;
  const password = process.env.NIMBUSPOST_PASSWORD;

  if (!email)    throw new Error('Missing env var: NIMBUSPOST_EMAIL');
  if (!password) throw new Error('Missing env var: NIMBUSPOST_PASSWORD');

  // Correct endpoint per NimbusPost Partners API docs
  const { ok, data } = await npFetch('/users/login', { method: 'POST', body: { email, password } });
  // Response format: { status: true, data: "JWT_TOKEN_STRING" }
  const token = data.data || data.token;
  if (!ok || !token) throw new Error(`NimbusPost login failed: ${JSON.stringify(data)}`);
  return token;
}

// NimbusPost tracking — Partners API has no dedicated tracking endpoint.
// We try a few patterns; the correct one may be undocumented.
// Confirmed endpoints from docs: /users/login, /shipments, /shipments/cancel,
// /shipments/manifest, /courier, /courier/serviceability, /ndr
async function npTrackBatch(token, awbs) {
  const attempts = [
    // Partners API most likely pattern
    { path: '/shipments/track', body: { awb_numbers: awbs } },
    // GET with AWB as query (for single AWB) — try first AWB to probe
    { path: `/shipments/${awbs[0]}`, body: null, method: 'GET' },
    // Alternative POST formats
    { path: '/courier/track', body: { awb_numbers: awbs } },
    { path: '/courier/track', body: { awbs } },
  ];

  for (const attempt of attempts) {
    const r = await npFetch(attempt.path, {
      method: attempt.method || 'POST', token,
      body: attempt.body,
    });
    console.log(`[NimbusPost Reconcile] ${attempt.method||'POST'} ${attempt.path} → ${r.status}`,
      JSON.stringify(r.data).slice(0, 200));
    if (r.ok && r.data && (r.data.data || r.data.status || r.data.awb_number || Array.isArray(r.data))) {
      return r.data?.data || r.data;
    }
  }

  // All attempts failed — return debug info so admin can see responses
  const last = await npFetch('/courier/serviceability', { method: 'GET', token });
  throw new Error(
    `NimbusPost tracking API not available. Auth is working (login succeeded). ` +
    `The Partners API (documenter.getpostman.com/view/9692837/TW6wHnoz) does not expose a tracking endpoint. ` +
    `Your orders will update automatically via the NimbusPost webhook as deliveries happen. ` +
    `Serviceability check: ${last.status} ${JSON.stringify(last.data).slice(0,100)}`
  );
}

// ── Notification helpers ───────────────────────────────────────────────────────
async function notifyDelivered(order) {
  if (!order.customer_phone) return;
  const firstName = (order.customer_name || 'there').split(' ')[0];
  const reviewUrl = `https://inkandchai.in/review/?order=${encodeURIComponent(order.razorpay_order_id || order.id)}`;
  try {
    await sendWhatsApp({
      to: order.customer_phone,
      template: 'order_delivered',
      params: [firstName, reviewUrl],
    });
  } catch (e) { console.warn('WhatsApp delivered notify failed:', e.message); }
}

async function notifyOFD(order) {
  if (!order.customer_phone) return;
  const firstName = (order.customer_name || 'there').split(' ')[0];
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const bookTitle = items[0]?.title || 'your book';
  const isCOD = !order.razorpay_payment_id || ['cod_pending','partial_cod_pending'].includes(order.status);
  const total = order.amount_paise ? `₹${(order.amount_paise / 100).toLocaleString('en-IN')}` : '';
  const trackUrl = order.tracking_url || `https://inkandchai.in/track/?id=${encodeURIComponent(order.razorpay_order_id || order.id)}`;
  try {
    await sendWhatsApp({
      to: order.customer_phone,
      template: 'order_out_for_delivery',
      params: [firstName, bookTitle, isCOD ? `Please keep ${total} cash ready` : 'No payment needed at door!', trackUrl],
    });
  } catch (e) { console.warn('WhatsApp OFD notify failed:', e.message); }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // ── Resolve list of (awb → order) pairs ────────────────────────────────
    let orders = [];

    if (body.all_shipped) {
      // All shipped orders in the last 90 days that have a tracking_id
      const since = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
      const { data } = await supabase
        .from('orders')
        .select('*')
        .in('status', ['shipped', 'out_for_delivery'])  // re-check stuck shipped + OFD orders
        .not('tracking_id', 'is', null)
        .gte('created_at', since)
        .limit(500);
      orders = data || [];
    } else if (Array.isArray(body.awbs) && body.awbs.length) {
      const { data } = await supabase
        .from('orders')
        .select('*')
        .in('tracking_id', body.awbs);
      orders = data || [];
    } else if (Array.isArray(body.order_ids) && body.order_ids.length) {
      const { data } = await supabase
        .from('orders')
        .select('*')
        .in('razorpay_order_id', body.order_ids);
      orders = data || [];
    } else {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide all_shipped:true, awbs:[], or order_ids:[]' }) };
    }

    if (!orders.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, message: 'No eligible orders found', total: 0, updated: 0 }) };
    }

    // ── Authenticate with NimbusPost ────────────────────────────────────────
    const token = await npAuthenticate();

    // ── Batch track (NimbusPost accepts up to ~50 per call) ────────────────
    const BATCH_SIZE = 50;
    const awbToOrder = {};
    orders.forEach(o => { if (o.tracking_id) awbToOrder[o.tracking_id] = o; });
    const allAwbs = Object.keys(awbToOrder);

    let trackingResults = {};
    let rawApiSample = null;
    for (let i = 0; i < allAwbs.length; i += BATCH_SIZE) {
      const batch = allAwbs.slice(i, i + BATCH_SIZE);
      const result = await npTrackBatch(token, batch);
      if (!rawApiSample) rawApiSample = JSON.stringify(result).slice(0, 500); // save first batch sample
      Object.assign(trackingResults, result);
    }
    console.log('[NimbusPost Reconcile] Sample tracking API response:', rawApiSample);

    // ── Apply updates ───────────────────────────────────────────────────────
    const summary = { total: allAwbs.length, updated: 0, delivered: 0, out_for_delivery: 0,
                      rto: 0, undelivered: 0, no_change: 0, not_found: 0 };

    for (const [awb, trackData] of Object.entries(trackingResults)) {
      const order = awbToOrder[awb];
      if (!order) { summary.not_found++; continue; }

      // NimbusPost may return different shapes — normalise
      const rawStatus = trackData?.status || trackData?.current_status || '';
      const ourStatus = normalizeStatus(rawStatus);

      if (!ourStatus) { summary.no_change++; continue; }
      if (ourStatus === order.status) { summary.no_change++; continue; }

      // Don't downgrade (e.g. delivered → out_for_delivery)
      const RANK = { shipped:1, out_for_delivery:2, delivered:3 };
      if ((RANK[ourStatus] || 0) <= (RANK[order.status] || 0)) { summary.no_change++; continue; }

      const updateData = { status: ourStatus };
      if (ourStatus === 'delivered') updateData.delivered_at = new Date().toISOString();

      await supabase.from('orders').update(updateData).eq('id', order.id);

      console.log(`[NimbusPost Reconcile] ${order.razorpay_order_id || order.id} ${order.status} → ${ourStatus} (AWB: ${awb})`);

      summary.updated++;
      summary[ourStatus] = (summary[ourStatus] || 0) + 1;

      // Send WhatsApp notification (customer hasn't received one for these old orders)
      if (ourStatus === 'delivered') await notifyDelivered(order);
      else if (ourStatus === 'out_for_delivery') await notifyOFD(order);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, summary, debug_api_sample: rawApiSample }),
    };

  } catch (err) {
    console.error('nimbuspost-reconcile error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
