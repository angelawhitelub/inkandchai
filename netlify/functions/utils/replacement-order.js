/**
 * Is this order a free/goodwill reshipment rather than a sale?
 *
 * Matters because every courier push decides COD by "is there money still to
 * collect", and a replacement's `amount_paise` is authoritative: 0 means the
 * customer owes nothing. Without this test the pushes fell back to the item
 * subtotal (the price the customer ALREADY paid on the original order) and the
 * courier turned up asking them to pay a second time for our own mistake.
 *
 * A replacement can still be COD on purpose — admin-create-replacement lets the
 * owner set amount_rs for a reship the customer agreed to pay for. That case is
 * `amount_paise > 0` and is unaffected by this helper.
 *
 * Checks four independent markers because rows reach the push from several
 * routes (customer report, admin creation, bulk import) and older rows predate
 * some of the columns.
 */
function isReplacementOrder(order, items) {
  if (!order) return false;
  if (String(order.source || '').toLowerCase() === 'replacement') return true;
  if (String(order.status || '').toLowerCase() === 'replacement_pending') return true;
  if (/^IC-R-/i.test(String(order.razorpay_order_id || ''))) return true;

  let cart = Array.isArray(items) ? items : order.cart_items;
  if (typeof cart === 'string') {
    try { cart = JSON.parse(cart); } catch { cart = []; }
  }
  return Array.isArray(cart) && cart.some(item => item && item._replacement);
}

module.exports = { isReplacementOrder };
