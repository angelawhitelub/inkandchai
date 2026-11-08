/**
 * Customer cancel for a paid order the courier has not picked up 7+ days
 * after it was placed (owner's rule, 11 Oct 2026 at 10 days; 7 days since
 * 3 Nov 2026): full refund, sent as soon as the cancel goes through. Used by
 * cancel-unpicked-order.js (My Orders button, from get-my-orders →
 * order.unpicked_cancel) and the WhatsApp bot's cancel_order.
 *
 * Covers what the other customer cancels do not:
 *   - prepaid, booked or not  late cancel (utils/prepaid-late-cancel) refuses
 *                             anything not yet picked up (15 Oct rule)
 *   - partial COD             otherwise only cancellable in its first 30 min;
 *                             here the advance comes back
 * Untouched: cancel-order.js (30-minute prepaid, COD before pickup) and the
 * automatic 10-day cancel of unshipped orders (utils/cancellation-guard).
 *
 * "Not picked up" is never taken from what we stored. The admin's Not Picked
 * Up cancel (admin-not-picked-up-cancel.handleOne) asks the courier live,
 * voids the AWB, and only then cancels through update-order-status, whose
 * refund and double-refund guards every other cancel uses. Whatever it will
 * not do on its own (no courier answer, courier refused) stays a request for
 * the owner instead of moving money.
 */
'use strict';

const { classify } = require('./not-picked-up');
const { isReplacementOrder } = require('./missing-books');

const UNPICKED_DAYS = 7;
const OPEN = ['paid', 'confirmed', 'processing', 'shipped', 'partial_cod_pending'];

function cartOf(order) {
  let cart = order?.cart_items;
  if (typeof cart === 'string') { try { cart = JSON.parse(cart); } catch { cart = []; } }
  return Array.isArray(cart) ? cart : [];
}

function isPartialCod(order) {
  if (String(order?.status || '').toLowerCase() === 'partial_cod_pending') return true;
  if (Number(order?.advance_paid_paise || 0) > 0) return true;
  if (String(order?.shipment_payment_type || '').toLowerCase() === 'partial_cod') return true;
  return cartOf(order).some((i) => {
    const m = i?._payment || i?.__payment || {};
    return String(m.mode || m.payment_type || '').toLowerCase() === 'partial_cod';
  });
}

/**
 * Can the customer cancel this order under the unpicked rule (UNPICKED_DAYS)? Pure: no I/O.
 * @returns {{eligible:true, refundPaise:number, partialCod:boolean, hasAwb:boolean}
 *          | {eligible:false, reason:string}}
 */
function quoteUnpickedCancel(order, now = Date.now()) {
  const no = (reason) => ({ eligible: false, reason });
  if (!order) return no('not_found');
  if (isReplacementOrder(order) || /^IC-R-/i.test(String(order.razorpay_order_id || ''))) return no('replacement');
  if (require('./order-split').splitChildren(order).length) return no('split');
  const amount = Number(order.amount_paise) || 0;
  if (!String(order.razorpay_payment_id || '').trim() || amount <= 0) return no('nothing_paid');
  if (order.wrong_cod_paise) return no('wrong_cod');
  if (order.late_cancel_at || order.cancellation_requested_at) return no('already_requested');
  const status = String(order.status || '').toLowerCase();
  if (!OPEN.includes(status)) return no('closed');

  const created = Date.parse(order.created_at || '');
  if (!Number.isFinite(created) || now - created < UNPICKED_DAYS * 86400e3) return no('too_soon');

  // Moved, delivered, RTO or terminal by what we know: classify() is the Not
  // Picked Up tab's own rule. The courier is asked again before anything moves.
  if (!classify(order, now, 0)) return no('moved');

  const partialCod = isPartialCod(order);
  const hasAwb = !!String(order.tracking_id || '').trim();
  return { eligible: true, refundPaise: amount, partialCod, hasAwb };
}

/** When the order becomes cancellable under this rule (ms), for a "from <date>" answer. */
function unpickedCancelFrom(order) {
  const created = Date.parse(order?.created_at || '');
  return Number.isFinite(created) ? created + UNPICKED_DAYS * 86400e3 : null;
}

module.exports = { quoteUnpickedCancel, unpickedCancelFrom, isPartialCod, UNPICKED_DAYS };
