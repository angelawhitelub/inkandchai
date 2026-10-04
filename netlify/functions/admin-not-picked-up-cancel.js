/**
 * Netlify Function: admin-not-picked-up-cancel
 * POST /.netlify/functions/admin-not-picked-up-cancel   (admin)
 *
 * Body: { order_ids: [uuid | IC-…, …] (max 10), dry_run?, confirm_manual? }
 *
 * Bulk "cancel & refund" for the Not Picked Up tab. Per order, in this order,
 * so a failure never costs both the book and the money:
 *
 *   1. Re-read the order. It must still be open and unmoved here.
 *   2. Ask the courier LIVE (utils/pickup-live). Picked up / delivered / RTO:
 *      left alone. On 3 Oct 2026 the tab listed parcels Delhivery had already
 *      delivered, so what we store is never trusted for this.
 *   3. Cancel the AWB with that courier. No explicit success: left alone.
 *   4. Cancel the order through the paths every other cancel uses, so the
 *      refund rules, double-refund guards and customer messages are theirs:
 *        replacement -> cancel-replacement (refund on the original; a COD
 *                       original gets an automatic UPI request by email and
 *                       WhatsApp)
 *        any other   -> update-order-status 'cancelled' (Razorpay refunded
 *                       there, PhonePe by the auto-refund in
 *                       notifyOrderCancelled; cancellation email + WhatsApp)
 *
 * No courier answer ("unknown"), or a panel we cannot reach (an order pushed to
 * iThink / the XpressBees panel with no AWB): returned as needs_manual. Only
 * with confirm_manual -- the admin saying they cancelled it in the courier
 * panel themselves -- is it cancelled and refunded.
 *
 * dry_run asks the couriers and says what would happen; it changes nothing.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { classify, UNBOOKED } = require('./utils/not-picked-up');
const { checkPickups, cancelAtCourier } = require('./utils/pickup-live');
const { isReplacementOrder, replacementMeta, replacementRefundPlan, reportedUpiId } = require('./utils/missing-books');
const { cancelNimbusOrder } = require('./utils/nimbuspost-cancel');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX = 10;
const rs = (paise) => Math.round(Number(paise || 0)) / 100;

// Static requires: the Worker bundler cannot follow a computed path.
const FUNCTIONS = {
  'update-order-status': () => require('./update-order-status'),
  'cancel-replacement': () => require('./cancel-replacement'),
};

async function callFunction(event, name, body) {
  const res = await FUNCTIONS[name]().handler({
    ...event, httpMethod: 'POST', path: `/.netlify/functions/${name}`, body: JSON.stringify(body),
  });
  let data = {};
  try { data = JSON.parse(res.body || '{}'); } catch { data = { error: String(res.body || '').slice(0, 200) }; }
  return { statusCode: res.statusCode, data };
}

/** What the customer gets back, before anything is done. */
async function refundPreview(sb, order) {
  if (isReplacementOrder(order)) {
    const originalId = String((replacementMeta(order) || {}).original_order_id || '').trim();
    const { data: original } = originalId
      ? await sb.from('orders').select('*').eq('razorpay_order_id', originalId).maybeSingle()
      : { data: null };
    const plan = replacementRefundPlan(order, original);
    const amount_rs = rs(plan.amountPaise);
    if (plan.action === 'gateway') return { via: 'gateway', amount_rs, message: `refund on ${originalId}` };
    if (plan.action === 'upi') {
      const onFile = String((replacementMeta(order) || {}).refund_upi_id || '').trim() || reportedUpiId(original);
      return { via: 'upi', amount_rs, upi_id: onFile || '',
               message: onFile ? `COD original: pay ₹${amount_rs} to UPI ${onFile} (already given)` : 'COD original: UPI ID asked by email + WhatsApp' };
    }
    if (plan.action === 'manual') return { via: 'manual', amount_rs, message: plan.reason };
    return { via: 'none', amount_rs: 0, message: plan.reason };
  }
  const paid = String(order.razorpay_payment_id || '').trim() && Number(order.amount_paise || 0) > 0;
  if (!paid) return { via: 'none', amount_rs: 0, message: 'COD — nothing was charged' };
  if (order.late_cancel_at) return { via: 'manual', amount_rs: rs(order.amount_paise), message: 'late cancel already owns this refund' };
  return { via: 'gateway', amount_rs: rs(order.amount_paise), message: String(order.razorpay_payment_id).startsWith('pay_') ? 'Razorpay' : 'PhonePe' };
}

async function handleOne(event, sb, order, opts) {
  const base = { id: order.id, order_id: order.razorpay_order_id || order.id };
  const status = String(order.status || '').toLowerCase();
  if (status !== 'shipped' && !UNBOOKED.includes(status)) return { ...base, outcome: 'skipped', reason: `order is "${status}"` };
  if (order.shipment_moved_at) return { ...base, outcome: 'skipped', reason: 'the courier has already moved it' };
  if (!classify(order, Date.now(), 0)) return { ...base, outcome: 'skipped', reason: `last scan "${order.last_courier_status || order.last_nimbuspost_status}" says it moved` };

  const refund = await refundPreview(sb, order);
  const awb = String(order.tracking_id || '').trim();
  let stop = null;   // how we know the parcel will not go out

  if (awb) {
    const live = (await checkPickups([order])).get(order.id);
    if (live.state !== 'unknown') {
      await sb.from('orders').update({ last_courier_status: live.status.slice(0, 200), last_courier_status_at: new Date().toISOString() })
        .eq('id', order.id).then(() => {}, () => {});
    }
    if (live.state === 'moved') return { ...base, outcome: 'skipped', reason: `courier says "${live.status}"`, live };
    if (live.state === 'unknown' && !opts.confirmManual) {
      return { ...base, outcome: 'needs_manual', reason: `no courier answered for AWB ${awb} — cancel it in the ${order.courier_name || 'courier'} panel first`, refund };
    }
    if (opts.dryRun) {
      return { ...base, outcome: live.state === 'unknown' ? 'needs_manual' : 'would_cancel',
               reason: live.state === 'cancelled' ? `courier already voided ${awb}` : `courier says "${live.status}" via ${live.channel}`, refund, live };
    }
    if (live.state === 'waiting') {
      const c = await cancelAtCourier(order, live);
      if (!c.ok) return { ...base, outcome: 'skipped', reason: c.message, live };
      stop = c.message;
    } else {
      stop = live.state === 'cancelled' ? `courier had already voided ${awb}` : 'admin confirmed it was cancelled in the courier panel';
    }
  } else {
    const unreachable = order.ithink_pushed_at ? 'iThink' : order.xpressbees_feed_at ? 'XpressBees panel' : null;
    if (unreachable && !opts.confirmManual) {
      return { ...base, outcome: 'needs_manual', reason: `sitting in the ${unreachable} with no AWB — cancel it there first`, refund };
    }
    if (opts.dryRun) return { ...base, outcome: 'would_cancel', reason: 'not booked with any courier yet', refund };
    if (order.nimbus_pushed_at) {
      const n = await cancelNimbusOrder(order.razorpay_order_id || order.id).catch((e) => ({ ok: false, error: e.message }));
      if (!n.ok && !opts.confirmManual) return { ...base, outcome: 'skipped', reason: `NimbusPost would not cancel its draft: ${n.error || 'no answer'}` };
    }
    stop = 'no AWB';
  }

  // ── The order itself, and the money ──────────────────────────────────────
  if (isReplacementOrder(order)) {
    const r = await callFunction(event, 'cancel-replacement', { id: order.id, shipment_stopped: true });
    if (r.statusCode !== 200) return { ...base, outcome: 'failed', reason: `courier stopped (${stop}) but the replacement was not cancelled: ${r.data.error || r.statusCode}` };
    const rf = r.data.refund || {};
    return {
      ...base, outcome: 'cancelled', reason: stop,
      refund: { status: rf.status || 'none', amount_rs: rs(rf.amount_paise), message: rf.message || '' },
      upi_request: r.data.upi_request || null,
    };
  }

  const r = await callFunction(event, 'update-order-status', { id: order.id, status: 'cancelled', tracking_id: '', courier_name: '' });
  if (r.statusCode !== 200) return { ...base, outcome: 'failed', reason: `courier stopped (${stop}) but the order was not cancelled: ${r.data.error || r.statusCode}` };
  const { data: after } = await sb.from('orders').select('status, refund_id, refund_utr').eq('id', order.id).maybeSingle();
  const now = String(after && after.status || 'cancelled');
  return {
    ...base, outcome: 'cancelled', reason: stop,
    refund: refund.via === 'gateway'
      ? { status: now === 'refunded' ? 'issued' : now === 'refund_pending' ? 'pending — check the gateway / Refunds' : now, amount_rs: refund.amount_rs, message: refund.message }
      : { status: refund.via === 'none' ? 'not_owed' : refund.via, amount_rs: refund.amount_rs, message: refund.message },
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS); if (block) return block;
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const ids = [...new Set((Array.isArray(body.order_ids) ? body.order_ids : []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!ids.length) return json(400, { error: 'Provide order_ids' });
  if (ids.length > MAX) return json(400, { error: `At most ${MAX} orders per call` });
  const opts = { dryRun: body.dry_run === true, confirmManual: body.confirm_manual === true };

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const results = [];
    for (const id of ids) {
      const { data: order, error } = await sb.from('orders').select('*').eq(UUID.test(id) ? 'id' : 'razorpay_order_id', id).maybeSingle();
      if (error) { results.push({ id, order_id: id, outcome: 'failed', reason: error.message }); continue; }
      if (!order) { results.push({ id, order_id: id, outcome: 'skipped', reason: 'order not found' }); continue; }
      try {
        results.push(await handleOne(event, sb, order, opts));
      } catch (e) {
        console.error('[admin-not-picked-up-cancel]', order.razorpay_order_id, e);
        results.push({ id: order.id, order_id: order.razorpay_order_id || order.id, outcome: 'failed', reason: e.message });
      }
    }
    if (!opts.dryRun) {
      console.log('[admin-not-picked-up-cancel]', results.map((r) => `${r.order_id}:${r.outcome}`).join(' '));
    }
    return json(200, { dry_run: opts.dryRun, results });
  } catch (e) {
    console.error('[admin-not-picked-up-cancel]', e);
    return json(500, { error: e.message });
  }
};
