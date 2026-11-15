/**
 * Netlify Function: admin-nimbuspost-order-cancel
 * POST /.netlify/functions/admin-nimbuspost-order-cancel   (admin)
 *   { order_ids: ['IC-…'], dry_run?: true }
 *
 * Cancels, FOR GOOD, every NimbusPost order behind orders that are already
 * cancelled or refunded here (v2 `POST /v2/orders/{id}/cancel`, scope "order";
 * utils/nimbuspost-order-cancel). Built for the 15 Nov 2026 clean-up: 9
 * cancelled/refunded orders had been booked a second time from NimbusPost's
 * New tab, because the old cancels only cancelled the shipment.
 *
 * restore_cancelled: true also accepts a SHIPPED order that nimbuspost-awb-sync
 * flipped back from cancelled onto the second AWB (it has previous_tracking_ids):
 * once NimbusPost has cancelled it, the row goes back to cancelled. No customer
 * message is sent (COD; the owner decides any correction message).
 *
 * dry_run defaults to TRUE: it reads NimbusPost live and lists what it would
 * cancel. A live order here is refused -- stopping its parcel is a different
 * decision. Picked-up parcels are reported (ask for an RTO), never cancelled.
 */
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { cancelNimbusOrderForGood } = require('./utils/nimbuspost-order-cancel');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const CLOSED_HERE = ['cancelled', 'refunded', 'refund_pending', 'partially_refunded', 'refund_failed'];
const MAX = 20;   // NimbusPost allows 60 calls a minute per key

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const blocked = requireAdmin(event, CORS); if (blocked) return blocked;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const ids = [...new Set((Array.isArray(body.order_ids) ? body.order_ids : String(body.order_ids || '').split(','))
    .map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  if (!ids.length) return json(400, { error: 'order_ids required' });
  if (ids.length > MAX) return json(400, { error: `At most ${MAX} orders at a time` });
  const dryRun = body.dry_run !== false;
  const restore = body.restore_cancelled === true;

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: orders, error } = await sb.from('orders').select('id, razorpay_order_id, status, tracking_id, courier_name, previous_tracking_ids, razorpay_payment_id').in('razorpay_order_id', ids);
  if (error) return json(500, { error: `orders query failed: ${error.message}` });
  const byId = new Map((orders || []).map((o) => [String(o.razorpay_order_id).toUpperCase(), o]));

  const results = [];
  for (const id of ids) {
    const o = byId.get(id);
    if (!o) { results.push({ order_id: id, action: 'refused', error: 'No such order' }); continue; }
    const flipped = restore && String(o.status || '').toLowerCase() === 'shipped' && !!o.previous_tracking_ids
      && !String(o.razorpay_payment_id || '').trim();
    if (!flipped && !CLOSED_HERE.includes(String(o.status || '').toLowerCase())) {
      results.push({ order_id: id, action: 'refused', status: o.status, error: 'Order is not cancelled or refunded here; not touched.' });
      continue;
    }
    const r = await cancelNimbusOrderForGood({ orderNumber: o.razorpay_order_id, reason: 'Order cancelled', dryRun });
    let restored = null;
    if (flipped && !dryRun && r.handled && !r.failed.length && !r.moving.length && (r.cancelled.length || r.already.length)) {
      const { error: uErr } = await sb.from('orders').update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancellation_source: 'admin',
        cancellation_reason: 'Booked twice in NimbusPost after the cancel; cancelled again',
        last_courier_status: 'cancelled', last_courier_status_at: new Date().toISOString(),
      }).eq('id', o.id).eq('status', 'shipped');
      restored = uErr ? `NOT restored: ${uErr.message}` : 'status back to cancelled';
    }
    results.push({
      order_id: id, status: o.status, restored, restore_eligible: flipped || undefined, our_awb: o.tracking_id || null, handled: r.handled,
      would_cancel: r.would_cancel, cancelled: r.cancelled, already: r.already, moving: r.moving, failed: r.failed,
      message: r.handled ? r.message : (r.error || 'Not found in NimbusPost'),
    });
  }
  return json(200, { dry_run: dryRun, results });
};
