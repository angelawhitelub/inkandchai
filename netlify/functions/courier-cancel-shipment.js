/**
 * Netlify Function: courier-cancel-shipment
 * POST /.netlify/functions/courier-cancel-shipment   { id }   (admin)
 *
 * Stops the courier shipment of an order that is ALREADY cancelled here.
 *
 * update-order-status cancels the XpressBees AWB only on the transition to
 * cancelled, so an order cancelled before that existed -- or whose courier
 * cancel failed at the time -- kept a live shipment with no way to stop it from
 * admin. The XpressBees panel's own "Cancel Order" is no help: on 29 Sep 2026
 * it showed "cancelled successfully" for IC-20260923-XB3M7 without sending any
 * request, and the AWB stayed "pending pickup".
 *
 * cancelCourierShipment re-reads the live XpressBees status first and cancels
 * only a shipment still waiting for pickup; one already moving is reported
 * back, never voided. Refuses any order not cancelled here: stopping a live
 * order's parcel is a different decision.
 *
 * Also accepted: an order the CUSTOMER cancelled and was refunded for
 * (late_cancel_at, utils/prepaid-late-cancel) whose status has slid back to
 * 'shipped' because a new AWB was attached to it. IC-20261006-HF8JF was
 * refunded on 11 Oct and re-booked on Delhivery through NimbusPost on 13 Oct.
 * Its status is put back to what the refund left it at; nothing is refunded
 * again and the customer is not messaged.
 *
 * Other couriers (NimbusPost, Delhivery, iThink): the courier is asked live
 * (utils/pickup-live) and only a parcel still waiting for pickup is cancelled.
 *
 * id: row uuid or IC-… order id.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { cancelCourierShipment, recordCourierCancel } = require('./utils/courier-shipment-cancel');
const { checkPickups, cancelAtCourier } = require('./utils/pickup-live');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REFUND_DONE = ['refunded', 'refund_pending', 'refund_failed'];
const STATUS_AFTER_REFUND = ['refunded', 'partially_refunded', 'refund_pending', 'refund_failed'];

/** Cancelled and paid back by the customer's own cancel, whatever status says now. */
function customerCancelled(order) {
  return !!order.late_cancel_at && REFUND_DONE.includes(String(order.late_cancel_state || ''));
}

/** Any courier but XpressBees: ask it live, cancel only while it waits for pickup. */
async function cancelOtherCourier(order, deps = {}) {
  const live = (await (deps.checkPickups || checkPickups)([order], deps)).get(order.id)
    || { state: 'unknown', status: '' };
  const awb = String(order.tracking_id).trim();
  if (live.state === 'cancelled') return { action: 'already_cancelled', awb, state: live.status, message: `${awb} is already cancelled at the courier.` };
  if (live.state === 'moved') {
    return { action: 'moving', awb, state: live.status,
             message: `${awb} is "${live.status}" — already picked up, so it was NOT cancelled. Ask the courier for an RTO.` };
  }
  if (live.state !== 'waiting') {
    return { action: 'error', awb, message: `No courier answered for ${awb}, so it was NOT cancelled. Cancel it in the courier panel.` };
  }
  const r = await (deps.cancelAtCourier || cancelAtCourier)(order, live, deps);
  return { action: r.ok ? 'cancelled' : 'error', awb, state: live.status, channel: live.channel, message: r.message };
}

/** The status a customer-cancelled order was left at once its refund went out. */
function statusAfterRefund(order) {
  const st = String(order.late_cancel_state || '');
  if (st !== 'refunded') return st === 'refund_failed' ? 'refund_failed' : 'refund_pending';
  return Number(order.refund_amount_paise) < Number(order.amount_paise) ? 'partially_refunded' : 'refunded';
}

async function stopShipment(sb, order, deps = {}) {
  const status = String(order.status || '').toLowerCase();
  const byCustomer = customerCancelled(order);
  if (status !== 'cancelled' && !byCustomer) {
    return { code: 400, body: { error: `Order is "${order.status}", not cancelled. Cancel the order first; that stops the shipment too.` } };
  }
  if (!order.tracking_id) return { code: 400, body: { error: 'This order has no AWB, so there is no shipment to stop.' } };

  const courier = /xpress/i.test(String(order.courier_name || ''))
    ? await (deps.cancelCourierShipment || cancelCourierShipment)(order)
    : await cancelOtherCourier(order, deps);
  const ok = ['cancelled', 'already_cancelled'].includes(courier.action);
  await (deps.recordCourierCancel || recordCourierCancel)(sb, order.id, courier);

  let restored = null;
  if (ok && byCustomer && !STATUS_AFTER_REFUND.includes(status) && status !== 'cancelled') {
    restored = statusAfterRefund(order);
    const fields = { status: restored };
    if (!order.cancelled_at) fields.cancelled_at = new Date().toISOString();
    const { error } = await sb.from('orders').update(fields).eq('id', order.id).eq('status', order.status);
    if (error) restored = `not restored: ${error.message}`;
  }
  return { code: 200, body: { ok, order_id: order.razorpay_order_id || order.id, courier, ...(restored ? { status_restored: restored } : {}) } };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const id = String(body.id || '').trim();
  if (!id) return json(400, { error: 'Missing order id' });

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: order, error } = await sb.from('orders').select('*')
      .eq(UUID.test(id) ? 'id' : 'razorpay_order_id', id).maybeSingle();
    if (error) throw error;
    if (!order) return json(404, { error: 'Order not found' });
    const r = await stopShipment(sb, order);
    return json(r.code, r.body);
  } catch (e) {
    console.error('[courier-cancel-shipment]', e);
    return json(500, { error: e.message || 'Could not cancel the shipment' });
  }
};

exports.__test = { stopShipment, customerCancelled, statusAfterRefund };
