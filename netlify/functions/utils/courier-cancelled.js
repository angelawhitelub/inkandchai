'use strict';

/**
 * XpressBees says the shipment is cancelled → cancel the order and refund it.
 *
 * The NimbusPost webhook has done this for a long time: a courier "cancelled"
 * becomes status=cancelled, and notifyOrderCancelled (the one cancellation
 * chokepoint) refunds a prepaid order and tells the customer. XpressBees
 * shipments had no equivalent -- utils/xpressbees-status.js deliberately
 * recorded "cancelled" and did nothing, so an order whose AWB XpressBees
 * dropped sat at `shipped` forever and a prepaid customer was never refunded.
 *
 * Why it was left out, and what makes it safe now:
 *
 *   - 51 panel rows were cancelled as housekeeping on 19 Sep for orders that
 *     had shipped through iThink. Those orders carry a different courier and
 *     tracking_id, so they never reach here: the cancelled AWB must be the
 *     order's CURRENT tracking_id, on an XpressBees order.
 *   - We cancel a panel shipment ourselves to re-book it. Until the new AWB
 *     comes back the old one reads "cancelled". So the first sighting only
 *     stamps courier_cancelled_at and emails the owner; the order is cancelled
 *     no sooner than GRACE_HOURS later, and only if the AWB is still the
 *     order's tracking_id and XpressBees still says cancelled when re-checked
 *     live at that moment. A re-book in the meantime replaces tracking_id and
 *     the old cancellation simply stops applying.
 *   - The same 10-day floor the NimbusPost webhook uses (cancellation-guard):
 *     an automated path may not cancel a younger order. It is revisited on
 *     every poll, so it proceeds once it is old enough -- unless someone
 *     re-books it first, which is what the first-sighting email is for.
 *   - A parcel that already moved, and a free replacement, are never cancelled
 *     here: both need a person, and the owner is told why.
 *
 * The refund itself is not done here. It is maybeAutoRefund inside
 * notifyOrderCancelled, which already skips refund states, RTO and unpaid
 * orders and never claims a refund is complete before the gateway does.
 *
 * Fails closed: if courier_cancelled_at / courier_cancelled_awb do not exist
 * yet (sql not run), the stamp fails and nothing is ever cancelled.
 */

const { cancellationAllowed, CANCEL_MIN_AGE_DAYS } = require('./cancellation-guard');
const { notifyOrderCancelled } = require('./order-cancelled-notification');
const { sendEmail } = require('./email');

const GRACE_HOURS_DEFAULT = 6;
// Where a live AWB can sit before delivery. out_for_delivery is left out on
// purpose: a courier cancel at the door is not a shipment that never went.
const ACTABLE = ['shipped', 'paid', 'confirmed', 'processing', 'cod_pending'];

/** XpressBees' own word for it. Narrow: this drives a money action. */
function courierSaysCancelled(status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s) return false;
  if (/cancellation\s+requested|rto|return/.test(s)) return false;
  return /\bcancell?ed\b/.test(s);
}

function graceHours() {
  const n = Number(process.env.COURIER_CANCEL_GRACE_HOURS);
  return Number.isFinite(n) && n >= 0 ? n : GRACE_HOURS_DEFAULT;
}

const isReplacement = (o) => String(o.source || '').toLowerCase() === 'replacement'
  || /^IC-R-/i.test(String(o.razorpay_order_id || ''));

const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function ownerHtml(order, awb, heading, lines) {
  const id = order.razorpay_order_id || order.id;
  const paid = order.razorpay_payment_id ? `prepaid ₹${(Number(order.amount_paise || 0) / 100).toLocaleString('en-IN')}` : 'COD / unpaid';
  return `
    <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:24px;background:#0d0b08;color:#f0e8d8;">
      <h2 style="color:#e0a94a;font-weight:400;margin:0 0 12px;">${esc(heading)}</h2>
      <p style="color:#a09080;font-size:13px;margin:0 0 12px;">Order <strong style="color:#c9a84c;">${esc(id)}</strong> · XpressBees AWB <strong>${esc(awb)}</strong> · ${esc(order.status)} · ${esc(paid)}<br>
      ${esc(order.customer_name || '')} · ${esc(order.customer_phone || '')}</p>
      ${lines.map(l => `<p style="line-height:1.7;margin:8px 0;">${l}</p>`).join('')}
      <p style="color:#7a6330;font-size:11px;margin-top:24px;">XpressBees courier-cancel handler · inkandchai.in</p>
    </div>`;
}

async function tellOwner(order, awb, subject, heading, lines, deps) {
  const to = process.env.STORE_OWNER_EMAIL;
  if (!to) return false;
  try {
    const r = await (deps.sendEmail || sendEmail)({ to, subject, html: ownerHtml(order, awb, heading, lines) });
    return !!(r && r.ok);
  } catch (e) {
    console.error('[courier-cancelled] owner email:', e.message);
    return false;
  }
}

/**
 * Act on "XpressBees says AWB <awb> is cancelled" for one order.
 *
 * @param {object} supabase
 * @param {string} orderRowId   orders.id
 * @param {object} opts         { awb, raw, liveChecked, dryRun, now }
 *   liveChecked: the caller has just read this status from the tracking API
 *   (the poller). Otherwise it is re-read before anything irreversible.
 * @param {object} deps         { track, notify, sendEmail } for tests
 * @returns {{ action: string, reason?: string, order?: string, refund?: object }}
 *   action: ignored | seen | waiting | held | cancelled | raced | error | would_cancel
 */
async function handleCourierCancelled(supabase, orderRowId, opts = {}, deps = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const awb = String(opts.awb || '').trim();
  const { data: order, error } = await supabase.from('orders').select('*').eq('id', orderRowId).maybeSingle();
  if (error || !order) return { action: 'error', reason: error ? error.message : 'order not found' };
  const ref = order.razorpay_order_id || order.id;

  if (!awb || String(order.tracking_id || '').trim() !== awb) {
    return { action: 'ignored', order: ref, reason: 'AWB is no longer this order\'s shipment' };
  }
  if (!/xpress/i.test(String(order.courier_name || ''))) {
    return { action: 'ignored', order: ref, reason: `courier is ${order.courier_name || 'unset'}, not XpressBees` };
  }
  const status = String(order.status || '').toLowerCase();
  if (!ACTABLE.includes(status)) {
    return { action: 'ignored', order: ref, reason: `order is ${status}` };
  }
  // The customer cancelled it themselves after dispatch: that refund is
  // shipping-deducted and belongs to utils/prepaid-late-cancel.js, whose sweep
  // reads this same "cancelled" as the courier accepting. A full refund from
  // here would hand back the shipping charge.
  if (order.late_cancel_at) {
    return { action: 'ignored', order: ref, reason: 'customer late-cancel owns this refund' };
  }

  // Why it would be held, worked out once so the first-sighting email can say.
  const verdict = cancellationAllowed(order, { now: now.getTime() });
  const hold = order.shipment_moved_at
    ? 'the parcel had already moved, so this needs a person, not an automatic refund'
    : isReplacement(order)
      ? 'it is a free replacement, so the customer is still owed the books — re-book it or arrange a refund by hand'
      : null;

  // ── First sighting: stamp, tell the owner, do nothing else ────────────────
  // Keyed to the AWB: a sighting for an earlier shipment of this order (since
  // re-booked) must not let this one skip its grace period.
  if (!order.courier_cancelled_at || String(order.courier_cancelled_awb || '') !== awb) {
    if (opts.dryRun) return { action: 'seen', order: ref, dry_run: true };
    const { error: stampErr } = await supabase.from('orders')
      .update({ courier_cancelled_at: now.toISOString(), courier_cancelled_awb: awb })
      .eq('id', order.id);
    if (stampErr) {
      const migration = /courier_cancelled_a/.test(stampErr.message || '');
      console.error(`[courier-cancelled] ${ref}: could not stamp — ${stampErr.message}`);
      return { action: 'error', order: ref, reason: migration ? 'orders.courier_cancelled_at is missing — run sql/orders_courier_cancelled_at.sql' : stampErr.message };
    }
    const when = hold
      ? `<strong>It will NOT be cancelled automatically:</strong> ${esc(hold)}.`
      : !verdict.allowed
        ? `It will be cancelled and refunded automatically once it is ${CANCEL_MIN_AGE_DAYS} days old (it is ${verdict.ageDays == null ? 'of unknown age' : verdict.ageDays.toFixed(1) + ' days'} now), and no sooner than ${graceHours()} hours from now.`
        : `It will be cancelled and refunded automatically in ${graceHours()} hours.`;
    await tellOwner(order, awb,
      `⚠️ XpressBees cancelled shipment ${awb} — ${ref}`,
      'XpressBees cancelled this shipment',
      [
        when,
        'To keep the order, re-book it before then: a new AWB replaces this one and the cancellation stops applying.',
      ], deps);
    return { action: 'seen', order: ref, held: hold || (!verdict.allowed ? verdict.reason : null) };
  }

  const seenAt = new Date(order.courier_cancelled_at).getTime();
  const waitMs = graceHours() * 3600 * 1000 - (now.getTime() - seenAt);
  if (!Number.isFinite(seenAt) || waitMs > 0) {
    return { action: 'waiting', order: ref, minutes_left: Number.isFinite(waitMs) ? Math.ceil(waitMs / 60000) : null };
  }
  if (hold) return { action: 'held', order: ref, reason: hold };
  if (!verdict.allowed) return { action: 'held', order: ref, reason: verdict.reason };

  // ── Re-read XpressBees before the irreversible part ───────────────────────
  if (!opts.liveChecked) {
    try {
      const track = deps.track || require('./xpressbees').track;
      const live = await track(awb);
      if (!courierSaysCancelled(live && live.status)) {
        return { action: 'ignored', order: ref, reason: `XpressBees now says "${live && live.status}"` };
      }
    } catch (e) {
      return { action: 'error', order: ref, reason: `live re-check failed: ${e.message}` };
    }
  }

  if (opts.dryRun) return { action: 'would_cancel', order: ref };

  // Claim it. The status and tracking_id conditions make a concurrent webhook
  // and poll, or a re-book landing this second, lose cleanly instead of
  // cancelling twice or cancelling the new shipment.
  const reason = `XpressBees cancelled shipment ${awb}`;
  let claim = await supabase.from('orders')
    .update({
      status: 'cancelled',
      cancellation_source: 'courier_xpressbees',
      cancellation_reason: reason,
      auto_cancelled_at: now.toISOString(),
      last_courier_status: 'cancelled',
      last_courier_status_at: now.toISOString(),
    })
    .eq('id', order.id)
    .eq('tracking_id', awb)
    .in('status', ACTABLE)
    .select('id');
  if (claim.error && /cancellation_|auto_cancelled_at|last_courier_status/.test(claim.error.message || '')) {
    claim = await supabase.from('orders')
      .update({ status: 'cancelled' })
      .eq('id', order.id)
      .eq('tracking_id', awb)
      .in('status', ACTABLE)
      .select('id');
  }
  if (claim.error) return { action: 'error', order: ref, reason: claim.error.message };
  if (!claim.data || !claim.data.length) return { action: 'raced', order: ref };

  console.log(`[courier-cancelled] ${ref} cancelled — ${reason}`);
  let notified = {};
  try {
    notified = await (deps.notify || notifyOrderCancelled)({ ...order, status: 'cancelled' }, {
      kind: 'store',
      reason: 'The courier cancelled the shipment and we could not re-book it.',
    });
  } catch (e) {
    console.error(`[courier-cancelled] ${ref} notify/refund:`, e.message);
  }
  const refund = notified && notified.refund;
  const refundLine = !order.razorpay_payment_id
    ? 'Nothing was paid online, so there is nothing to refund.'
    : refund && refund.ok
      ? `Refund ${esc(refund.nextStatus || refund.state || 'issued')} via ${esc(refund.provider || 'gateway')}${refund.merchantRefundId ? ` (${esc(refund.merchantRefundId)})` : ''}.`
      : refund && refund.skipped
        ? `No refund issued (${esc(refund.skipped)}).`
        : `<strong>Refund did not go through${refund && refund.error ? `: ${esc(refund.error)}` : ''}.</strong> The order is at refund_pending — retry it from the admin panel.`;
  await tellOwner({ ...order, status: 'cancelled' }, awb,
    `✅ ${ref} cancelled — XpressBees cancelled AWB ${awb}`,
    'Order cancelled after XpressBees cancelled the shipment',
    [refundLine, `Customer notified: email ${notified && notified.email ? 'sent' : 'not sent'}, WhatsApp ${notified && notified.whatsapp ? 'sent' : 'not sent'}.`],
    deps);
  return { action: 'cancelled', order: ref, refund: refund || null, notified: { email: !!(notified && notified.email), whatsapp: !!(notified && notified.whatsapp) } };
}

/** The courier stopped saying cancelled (re-activated): forget the sighting. */
async function clearCourierCancelled(supabase, orderRowId) {
  const { error } = await supabase.from('orders').update({ courier_cancelled_at: null, courier_cancelled_awb: null }).eq('id', orderRowId);
  if (error && !/courier_cancelled_a/.test(error.message || '')) console.error('[courier-cancelled] clear:', error.message);
}

module.exports = { courierSaysCancelled, handleCourierCancelled, clearCourierCancelled, ACTABLE, GRACE_HOURS_DEFAULT };
