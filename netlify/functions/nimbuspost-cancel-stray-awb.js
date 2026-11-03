/**
 * Netlify Function: nimbuspost-cancel-stray-awb
 * POST /.netlify/functions/nimbuspost-cancel-stray-awb   (admin)
 *
 * Body: { order_id: "IC-…", awb: "<NimbusPost AWB>", dry_run: true }
 *
 * Cancels ONE NimbusPost booking that is not the order's shipment: a second
 * booking of an order already shipping on another AWB, or a fresh booking of
 * an order cancelled here. On 3 Nov 2026 two COD orders were booked on
 * XpressBees and then on NimbusPost 35 minutes later, and a cancelled order
 * was booked again; courier-cancel-shipment could not help, because it only
 * ever cancels the AWB stored on the order row.
 *
 * Guards, none bypassable:
 *   1. NimbusPost must know the AWB, and its order number must be this order.
 *   2. It must still be waiting for pickup; anything moving is reported only.
 *   3. It must not be the order's live shipment: the order is cancelled here,
 *      or its tracking_id is a different, non-empty AWB.
 *
 * SENDS NOTHING TO THE CUSTOMER and writes nothing to the order row: the
 * shipment the customer was told about is the one left standing.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const np = require('./utils/nimbuspost-cancel');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const MOVED = /\b(shipped|dispatch|picked|pickup done|in transit|out for delivery|delivered|rto|return to origin|ndr|undelivered|lost)\b/;
const WAITING = /\b(booked|manifest|pickup scheduled|pickup pending|ready to ship|new|pending|awb assigned)\b/;
const norm = (s) => String(s || '').trim().toUpperCase();
// NimbusPost keeps a cancelled order number reserved, so a re-booking carries a suffix.
const baseOrder = (s) => norm(s).replace(/-C\d+$/, '');

/** Why this AWB may be cancelled for this order, or null when it is the live shipment. */
function strayReason(order, awb) {
  if (String(order.status || '').toLowerCase() === 'cancelled') return 'order_cancelled_here';
  const ours = norm(order.tracking_id);
  if (ours && ours !== norm(awb)) return 'order_ships_on_another_awb';
  return null;
}

async function cancelStray({ orderId, awb, dryRun }, deps = {}) {
  const sb = deps.supabase;
  const { data: order, error } = await sb.from('orders')
    .select('id, razorpay_order_id, status, courier_name, tracking_id')
    .eq('razorpay_order_id', orderId).maybeSingle();
  if (error) return { status: 500, body: { error: `orders query failed: ${error.message}` } };
  if (!order) return { status: 404, body: { error: `No order ${orderId}` } };

  const reason = strayReason(order, awb);
  if (!reason) {
    return { status: 409, body: { error: `${awb} is ${orderId}'s own shipment and the order is not cancelled; not touched.` } };
  }

  const rows = await (deps.track || np.trackNimbusShipments)([awb]);
  const row = rows.find((r) => norm(r.awb_number || np.awbFromRow(r)) === norm(awb));
  if (!row) return { status: 404, body: { error: `NimbusPost does not know ${awb}; not cancelled.` } };
  const theirs = np.orderNumberFromRow(row) || row.order_number;
  if (baseOrder(theirs) !== baseOrder(orderId)) {
    return { status: 409, body: { error: `${awb} belongs to ${theirs || 'another order'} at NimbusPost, not ${orderId}; not cancelled.` } };
  }
  const state = np.shipmentStatusFromRow(row);
  const s = state.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const summary = { order_id: orderId, awb, reason, nimbuspost_status: state, our_awb: order.tracking_id || null, our_courier: order.courier_name || null };
  if (np.rowIsCancelled(row)) return { status: 200, body: { ...summary, action: 'already_cancelled' } };
  if (MOVED.test(s) || !WAITING.test(s)) {
    return { status: 409, body: { ...summary, action: 'not_waiting', error: `${awb} is "${state}", not waiting for pickup; not cancelled.` } };
  }
  if (dryRun) return { status: 200, body: { ...summary, action: 'would_cancel', dry_run: true } };

  const r = await (deps.cancel || np.cancelNimbusShipment)(awb);
  if (!r.ok) return { status: 502, body: { ...summary, action: 'error', error: r.error || 'NimbusPost refused' } };
  return { status: 200, body: { ...summary, action: r.alreadyCancelled ? 'already_cancelled' : 'cancelled' } };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const blocked = requireAdmin(event, CORS); if (blocked) return blocked;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const orderId = norm(body.order_id);
  const awb = String(body.awb || '').trim();
  if (!orderId || !/^[A-Z0-9-]{6,40}$/.test(awb.toUpperCase())) return json(400, { error: 'order_id and awb are required' });

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const out = await cancelStray({ orderId, awb, dryRun: body.dry_run !== false }, { supabase });
    console.log(`[nimbuspost-cancel-stray-awb] ${orderId} ${awb} → ${out.body.action || out.body.error}`);
    return json(out.status, out.body);
  } catch (e) {
    console.error('[nimbuspost-cancel-stray-awb]', e.message);
    return json(500, { error: e.message });
  }
};

module.exports._test = { cancelStray, strayReason };
