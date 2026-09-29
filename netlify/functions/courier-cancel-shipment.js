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
 * id: row uuid or IC-… order id.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { cancelCourierShipment, recordCourierCancel } = require('./utils/courier-shipment-cancel');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    if (String(order.status || '').toLowerCase() !== 'cancelled') {
      return json(400, { error: `Order is "${order.status}", not cancelled. Cancel the order first; that stops the shipment too.` });
    }
    if (!order.tracking_id) return json(400, { error: 'This order has no AWB, so there is no shipment to stop.' });

    const courier = await cancelCourierShipment(order);
    await recordCourierCancel(sb, order.id, courier);
    const ok = ['cancelled', 'already_cancelled'].includes(courier.action);
    return json(200, { ok, order_id: order.razorpay_order_id || order.id, courier });
  } catch (e) {
    console.error('[courier-cancel-shipment]', e);
    return json(500, { error: e.message || 'Could not cancel the shipment' });
  }
};
