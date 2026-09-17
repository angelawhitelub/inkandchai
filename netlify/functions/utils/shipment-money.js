/**
 * How much does the courier declare, and how much does it collect?
 *
 * Lifted verbatim in behaviour from nimbuspost-ship.js, where it was inlined.
 * It is extracted here so the iThink push cannot drift from the NimbusPost
 * push: getting this wrong is not a bug that shows up in a test run, it is a
 * parcel delivered without collecting a rupee. Thirty-six real orders shipped
 * with collectable_amount 0 before the status-based test was replaced with the
 * money-based one below.
 *
 * The rules, in the order they must be applied:
 *
 *   1. A REPLACEMENT is never COD. Its cart is copied from the original order,
 *      so a partial-COD balance the customer already settled rides along with
 *      it; collecting on that a second time charges them twice for a free
 *      reship. Any amount on a replacement is a DECLARED VALUE, not permission
 *      to collect.
 *   2. PARTIAL COD is tested BEFORE prepaid. A partial-COD deposit is a real
 *      captured gateway payment, so a prepaid-first test would see
 *      razorpay_payment_id, call the order fully paid, and collect nothing.
 *   3. COD is decided by WHETHER MONEY IS STILL OWED, never by the status
 *      label. The admin's Update-status dropdown can set 'confirmed' on an
 *      unpaid order, and a status whitelist let those through as prepaid.
 *
 * Partial-COD amounts live in cart_items[0]._payment, written by
 * verify-payment. If that metadata is missing we FAIL CLOSED: once an AWB is
 * assigned the courier will not let us change the collectable amount, so a
 * wrong number here is unrecoverable.
 */
'use strict';

function parseCartItems(cartItems) {
  if (Array.isArray(cartItems)) return cartItems;
  try { const p = JSON.parse(cartItems || '[]'); return Array.isArray(p) ? p : []; }
  catch { return []; }
}

/**
 * @param {object} order       a row from `orders`
 * @param {boolean} isReplacement  result of isReplacementOrder(order)
 * @returns {{isCOD, isPartialCod, fullyPrepaid, orderValueRs, collectableAmount,
 *            advanceRs, shipmentPaymentType}}
 * @throws when a partial-COD order has no balance metadata
 */
function classifyShipmentMoney(order, isReplacement) {
  const amountRs = order.amount_paise ? Math.round(order.amount_paise / 100) : 0;

  const items = parseCartItems(order.cart_items);
  const pm = (items[0] && items[0]._payment) || {};
  const partialBalanceRs = Math.round(Math.max(0, Number(pm.balance || 0)));
  const partialFullRs    = Math.round(Math.max(0, Number(pm.full_total || 0))) || (partialBalanceRs + amountRs);

  const isPartialCod = !isReplacement && (order.status === 'partial_cod_pending'
    || Number(order.advance_paid_paise || 0) > 0
    || partialBalanceRs > 0);

  const fullyPrepaid = !isPartialCod
    && (Boolean(order.razorpay_payment_id) || String(order.status || '').toLowerCase() === 'paid');

  const isCOD = !isReplacement && (isPartialCod || (!fullyPrepaid && amountRs > 0));

  if (isPartialCod && partialBalanceRs <= 0) {
    const id = order.razorpay_order_id || order.id;
    throw new Error(`Partial-COD order ${id} is missing its balance metadata `
      + `(cart_items[0]._payment.balance); refusing to assign an AWB with a wrong collectable amount.`);
  }

  // A free replacement has amount_paise 0, which would declare a zero-value
  // parcel and leave nothing to claim if the courier loses it. Fall back to
  // what the books are worth -- for the DECLARED value only. The collectable
  // stays 0 because isCOD is false.
  const replacementValueRs = isReplacement
    ? Math.round(items.reduce((sum, i) =>
        sum + (Number(i?.price || 0) * Math.max(1, Number(i?.qty || i?.quantity || 1))), 0))
    : 0;

  const orderValueRs      = isPartialCod ? partialFullRs : (amountRs || replacementValueRs);
  const collectableAmount = isPartialCod ? partialBalanceRs : (isCOD ? amountRs : 0);
  const advanceRs         = isPartialCod ? Math.max(0, orderValueRs - collectableAmount) : 0;

  return {
    isCOD,
    isPartialCod,
    fullyPrepaid,
    orderValueRs,
    collectableAmount,
    advanceRs,
    shipmentPaymentType: isPartialCod ? 'partial_cod' : (isCOD ? 'cod' : 'prepaid'),
  };
}

module.exports = { classifyShipmentMoney, parseCartItems };
