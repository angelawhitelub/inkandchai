/**
 * Part refunds on orders that still have to ship (owner, 28 Nov 2026).
 *
 * The admin can refund some books of a multi-book order (out of stock, say)
 * from Orders or Not Picked Up, and the rest still ship. Such a partial no
 * longer flips the order to 'partially_refunded' (which took it out of Not
 * Picked Up, labels and the warehouse app): the shipping status stays and the
 * refund is recorded in refund_id / refund_state / refund_items.
 *
 * Because the status no longer says "refunded", every automatic full refund
 * (cancel, unpicked cancel, late cancel) checks hasPriorRefund first and
 * leaves the rest to a person, so the same money is never sent twice.
 */
'use strict';

// Still on its way to the customer: a part refund keeps this status.
const SHIPPING_OPEN = ['paid', 'confirmed', 'processing', 'shipped', 'partial_cod_pending', 'in_transit', 'out_for_delivery'];

function keepStatusOnPartial(order) {
  return SHIPPING_OPEN.includes(String(order?.status || '').toLowerCase());
}

/** A refund was already sent (or is on its way) on this order's payment. */
function hasPriorRefund(order) {
  if (!order || !String(order.refund_id || '').trim()) return false;
  return String(order.refund_state || '').toUpperCase() !== 'FAILED';
}

/** ₹ already refunded, from the ticked books (0 when it was typed by hand). */
function priorRefundRs(order) {
  const items = Array.isArray(order?.refund_items) ? order.refund_items : [];
  return Math.round(items.reduce((s, i) => s + (Number(i?.amount) || 0), 0) * 100) / 100;
}

module.exports = { SHIPPING_OPEN, keepStatusOnPartial, hasPriorRefund, priorRefundRs };
