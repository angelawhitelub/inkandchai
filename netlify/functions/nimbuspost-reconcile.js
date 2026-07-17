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
const { requireAdmin } = require('./utils/admin-auth');
const {
  sendInTransitNotifications,
  sendOFDNotification,
  sendDeliveredNotification,
} = require('./utils/delivery-notifications');

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
  'in transit':         'in_transit',
  'intransit':          'in_transit',
  'in-transit':         'in_transit',
  'reached at hub':     'in_transit',
  'in sorting centre':  'in_transit',
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
  // Documented Partners API bulk-tracking endpoint — up to 100 AWBs per call:
  //   POST /v1/shipments/track/bulk  { awb: [...] }
  //   → { status: true, data: [ { awb_number, status, history: [...] }, ... ] }
  // (documenter.getpostman.com/view/9692837/TW6wHnoz → "Bulk Shipment Tracking")
  const r = await npFetch('/shipments/track/bulk', { method: 'POST', token, body: { awb: awbs } });
  console.log(`[NimbusPost Reconcile] POST /shipments/track/bulk (${awbs.length} AWBs) → ${r.status}`,
    JSON.stringify(r.data).slice(0, 200));
  if (r.ok && Array.isArray(r.data?.data)) {
    // Key by AWB — the caller merges these maps and looks orders up by tracking_id.
    const map = {};
    for (const row of r.data.data) {
      const awb = String(row?.awb_number || row?.awb || '').trim();
      if (awb) map[awb] = row;
    }
    return map;
  }
  throw new Error(`NimbusPost bulk tracking failed (HTTP ${r.status}): ${JSON.stringify(r.data).slice(0, 200)}`);
}

// Notification helpers live in ./utils/delivery-notifications (shared with the
// webhook so customers get the same email + WhatsApp on every stage).

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

      // ── In transit ─────────────────────────────────────────────────────────
      // Never changes status; notify once, deduped via in_transit_notified_at
      // (atomic claim). Skips silently if the column/migration isn't there yet.
      if (ourStatus === 'in_transit') {
        if (['out_for_delivery', 'delivered', 'cancelled', 'rto', 'lost', 'undelivered'].includes(order.status)) { summary.no_change++; continue; }
        if (order.in_transit_notified_at) { summary.no_change++; continue; }
        const claim = await supabase
          .from('orders')
          .update({ in_transit_notified_at: new Date().toISOString() })
          .eq('id', order.id)
          .is('in_transit_notified_at', null)
          .select('id');
        if (claim.error || !claim.data || claim.data.length === 0) { summary.no_change++; continue; }
        await sendInTransitNotifications(order, awb);
        summary.updated++;
        continue;
      }

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

      // Send email + WhatsApp (customer hasn't received one for these old orders)
      if (ourStatus === 'delivered') await sendDeliveredNotification(order);
      else if (ourStatus === 'out_for_delivery') await sendOFDNotification(order);
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
