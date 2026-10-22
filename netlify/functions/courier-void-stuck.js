/**
 * Netlify Function: courier-void-stuck
 * POST /.netlify/functions/courier-void-stuck   (admin)
 *
 * For orders the courier never picked up: stop the XpressBees AWB, cancel
 * NimbusPost's copy, and cancel + refund the order once it is old enough.
 *
 * On 1 Oct 2026, 46 XpressBees AWBs had sat at "pending pickup" for 7-15 days
 * ("Pickup Not Done" scan after scan). courier-cancel-shipment refuses a live
 * order and update-order-status cancels the order before it looks at the
 * parcel, so there was no way to stop a batch of them safely.
 *
 * Per order, in this order, stopping at the first thing that is not clean:
 *   1. XpressBees: cancelCourierShipment re-reads the LIVE status and voids the
 *      AWB only while it is still waiting for pickup. A parcel that has moved
 *      is reported back and nothing else happens to that order.
 *   2. NimbusPost: its copy of the order (draft or AWB) is cancelled when the
 *      order was ever pushed there.
 *   3. The order itself:
 *        - at least min_age_days old (default 10, the same floor every
 *          automated cancel uses) and not a free replacement: cancelled through
 *          update-order-status, which is the admin "Cancel" button -- refund
 *          and customer message included, exactly as a hand cancel.
 *        - younger, or a replacement: handed to the XpressBees courier-cancel
 *          handler (first sighting stamped now), which cancels and refunds it
 *          once it is old enough, and holds replacements for a person.
 *
 * Body: { order_ids: ['IC-…'], dry_run?: true, min_age_days?: 10 }
 * dry_run defaults to TRUE: it reads live statuses and says what would happen.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { cancelCourierShipment, recordCourierCancel, liveStatus, CANCELLABLE } = require('./utils/courier-shipment-cancel');
const { cancelNimbusOrder } = require('./utils/nimbuspost-cancel');
const { handleCourierCancelled, ACTABLE } = require('./utils/courier-cancelled');
const { orderAgeDays, CANCEL_MIN_AGE_DAYS } = require('./utils/cancellation-guard');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const MAX_ORDERS = 60;

const isReplacement = (o) => String(o.source || '').toLowerCase() === 'replacement'
  || /^IC-R-/i.test(String(o.razorpay_order_id || ''));

/** One order. deps: supabase, xbTrack, cancelCourier, recordCancel, cancelNimbus, cancelOrder, markCancelled, now */
async function voidOne(deps, orderId, { dryRun, minAgeDays }) {
  const { data: order, error } = await deps.supabase.from('orders').select('*')
    .eq('razorpay_order_id', orderId).maybeSingle();
  if (error) return { order: orderId, outcome: 'error', reason: error.message };
  if (!order) return { order: orderId, outcome: 'not_found' };

  const status = String(order.status || '').toLowerCase();
  const out = { order: orderId, status, awb: order.tracking_id || null };
  if (!ACTABLE.includes(status)) return { ...out, outcome: 'skipped', reason: `order is ${status}` };
  if (!order.tracking_id) return { ...out, outcome: 'skipped', reason: 'no AWB' };
  if (!/xpress/i.test(String(order.courier_name || ''))) {
    return { ...out, outcome: 'skipped', reason: `courier is ${order.courier_name || 'unset'}, not XpressBees` };
  }

  const age = orderAgeDays(order, deps.now);
  out.age_days = age == null ? null : Math.round(age * 10) / 10;
  const fullCancel = !isReplacement(order) && age != null && age >= minAgeDays;
  out.plan = fullCancel ? 'cancel_and_refund_now' : isReplacement(order) ? 'held_replacement' : 'automation_when_old_enough';

  if (dryRun) {
    let state = '';
    try { state = liveStatus(await deps.xbTrack(order.tracking_id)); } catch (e) {
      return { ...out, outcome: 'error', reason: `live status: ${e.message}` };
    }
    out.live = state;
    const stoppable = /cancel/i.test(state) || CANCELLABLE.test(state);
    return { ...out, outcome: stoppable ? 'would_void' : 'moving', nimbus: !!order.nimbus_pushed_at };
  }

  // 1. XpressBees
  const courier = await deps.cancelCourier(order);
  await deps.recordCancel(deps.supabase, order.id, courier);
  out.courier = courier.action;
  if (!['cancelled', 'already_cancelled'].includes(courier.action)) {
    return { ...out, outcome: 'not_stopped', reason: courier.message };
  }

  // 2. NimbusPost's copy
  if (order.nimbus_pushed_at) {
    const np = await deps.cancelNimbus(order.razorpay_order_id);
    out.nimbus = np.ok ? (np.alreadyCancelled ? 'already_cancelled' : 'cancelled') : `failed: ${np.error || 'unknown'}`;
  }

  // 3. The order
  if (fullCancel) {
    const r = await deps.cancelOrder(order);
    if (r.statusCode !== 200) return { ...out, outcome: 'order_cancel_failed', reason: r.data.error || `HTTP ${r.statusCode}` };
    return { ...out, outcome: 'cancelled', refund: r.data.refund || null };
  }
  const h = await deps.markCancelled(deps.supabase, order.id, { awb: order.tracking_id });
  return { ...out, outcome: 'voided', automation: h.action, held: h.held || h.reason || null };
}

async function runVoid(deps, orderIds, { dryRun = true, minAgeDays = CANCEL_MIN_AGE_DAYS } = {}) {
  const results = [];
  for (const id of orderIds) {
    try { results.push(await voidOne(deps, id, { dryRun, minAgeDays })); } catch (e) {
      results.push({ order: id, outcome: 'error', reason: e.message });
    }
  }
  const count = {};
  for (const r of results) count[r.outcome] = (count[r.outcome] || 0) + 1;
  return { dry_run: dryRun, min_age_days: minAgeDays, count, results };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const ids = [...new Set((Array.isArray(body.order_ids) ? body.order_ids : []).map(s => String(s || '').trim()).filter(Boolean))];
  if (!ids.length) return json(400, { error: 'order_ids required' });
  if (ids.length > MAX_ORDERS) return json(400, { error: `At most ${MAX_ORDERS} orders per call` });
  const minAge = Number(body.min_age_days);
  const minAgeDays = Number.isFinite(minAge) && minAge >= CANCEL_MIN_AGE_DAYS ? minAge : CANCEL_MIN_AGE_DAYS;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const deps = {
    supabase,
    now: Date.now(),
    xbTrack: (awb) => require('./utils/xpressbees').track(awb),
    cancelCourier: cancelCourierShipment,
    recordCancel: recordCourierCancel,
    cancelNimbus: cancelNimbusOrder,
    markCancelled: handleCourierCancelled,
    // The admin "Cancel" button, as this same admin.
    cancelOrder: async (order) => {
      const res = await require('./update-order-status').handler({
        ...event, httpMethod: 'POST', path: '/.netlify/functions/update-order-status',
        body: JSON.stringify({ id: order.id, status: 'cancelled' }),
      });
      let data = {};
      try { data = JSON.parse(res.body || '{}'); } catch { data = { error: String(res.body || '').slice(0, 200) }; }
      return { statusCode: res.statusCode, data };
    },
  };
  try {
    return json(200, await runVoid(deps, ids, { dryRun: body.dry_run !== false, minAgeDays }));
  } catch (e) {
    console.error('[courier-void-stuck]', e);
    return json(500, { error: e.message });
  }
};

exports.runVoid = runVoid;
