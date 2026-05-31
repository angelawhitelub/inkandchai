/**
 * Netlify Function: nimbuspost-reconcile
 * POST /.netlify/functions/nimbuspost-reconcile
 *
 * Batch-reconciles shipped orders against NimbusPost's live tracking API.
 * Solves the "stuck at shipped" problem for orders that were already
 * shipped before the webhook was connected.
 *
 * Body options:
 *   { all_shipped: true }       — check ALL orders with status='shipped' (last 90 days)
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

// ── NimbusPost helpers (same pattern as nimbuspost-ship.js) ───────────────────
async function npFetch(path, { method = 'GET', token, body } = {}) {
  const apiKey = process.env.NIMBUSPOST_API_KEY;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  if (token)  headers['NP-API-SECRET'] = token;
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
  const apiKey   = process.env.NIMBUSPOST_API_KEY;
  if (!apiKey || !email || !password) throw new Error('NIMBUSPOST_API_KEY / EMAIL / PASSWORD not set');
  const { ok, data } = await npFetch('/authenticate', { method: 'POST', body: { email, password } });
  if (!ok || !data.token) throw new Error(`NimbusPost auth failed: ${JSON.stringify(data)}`);
  return data.token;
}

// NimbusPost tracking endpoint — POST /shipments/track with { awbs: [...] }
async function npTrackBatch(token, awbs) {
  const { ok, data } = await npFetch('/shipments/track', {
    method: 'POST',
    token,
    body: { awbs },
  });
  if (!ok) throw new Error(`NimbusPost track failed: ${JSON.stringify(data)}`);
  // Response: { status: true, data: { AWB1: { status: "...", ... }, ... } }
  return data.data || data;
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

  const adminKey = process.env.ADMIN_SECRET;
  const sentKey  = event.headers['x-admin-key'] || event.headers['X-Admin-Key'];
  if (!adminKey || sentKey !== adminKey) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

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
        .in('status', ['shipped'])  // only re-check orders stuck at shipped
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
    for (let i = 0; i < allAwbs.length; i += BATCH_SIZE) {
      const batch = allAwbs.slice(i, i + BATCH_SIZE);
      const result = await npTrackBatch(token, batch);
      Object.assign(trackingResults, result);
    }

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
      body: JSON.stringify({ success: true, summary }),
    };

  } catch (err) {
    console.error('nimbuspost-reconcile error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
