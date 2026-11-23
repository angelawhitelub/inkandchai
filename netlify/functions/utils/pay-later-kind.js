'use strict';

/**
 * Is this a Pay Later order (utils/pay-later)? Kept dependency-free because
 * every courier path asks it: a Pay Later parcel is booked as PREPAID and the
 * courier must never collect cash for it, paid yet or not. The customer pays
 * by the Razorpay link sent after delivery.
 */
function payLaterMeta(order) {
  let items = order && order.cart_items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
  const p = Array.isArray(items) && items[0] && items[0]._payment;
  return p && p.mode === 'pay_later' ? p : null;
}

const isPayLater = (order) => !!payLaterMeta(order);

/** Pay Later and not paid yet (no gateway payment, no manual "paid"). */
function isUnpaidPayLater(order) {
  const p = payLaterMeta(order);
  if (!p) return false;
  if (String((order && order.razorpay_payment_id) || '').trim()) return false;
  return !['paid', 'paid_manual'].includes(p.state);
}

module.exports = { payLaterMeta, isPayLater, isUnpaidPayLater };
