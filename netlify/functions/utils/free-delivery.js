'use strict';

/**
 * Free delivery switched on per book (sql/product_free_delivery.sql), set from
 * the admin product editor. An order holding any such book ships free, however
 * small: the product page promises "Free delivery", and a ₹40 charge for adding
 * a second book would break that promise.
 *
 * The server decides (utils/pricing marks the cart line _free_delivery and
 * orderShipping reads it). The checkout, the cart drawer and the Worker's
 * product-page badge read the public free-delivery-slugs list, and MUST agree
 * with orderShipping or the order is answered with a 409 "price changed".
 */

const { cleanSlug } = require('./cod-rules');

const TABLE = 'product_free_delivery';
// Order-level free delivery depends on how the order is paid (owner, 26 Oct
// 2026): prepaid ships free ABOVE ₹399 (strict, like the site sale: ₹399 pays
// shipping, ₹400 does not), Cash on Delivery -- partial COD included -- from
// ₹499. FREE_SHIPPING_THRESHOLD stays the COD figure for older callers.
const PREPAID_FREE_ABOVE = 399;
const COD_FREE_FROM = 499;
const FREE_SHIPPING_THRESHOLD = COD_FREE_FROM;
const SHIPPING_FEE = 40;

/** 'prepaid' for a fully paid-online order, else 'cod' (COD and partial COD). */
function shippingMode(paymentMode) {
  const m = String(paymentMode || '').toLowerCase();
  return m === 'prepaid' || m === 'online' || m === 'razorpay' || m === 'phonepe' ? 'prepaid' : 'cod';
}

/** True when the subtotal alone earns free delivery for this payment mode. */
function freeByAmount(subtotal, mode) {
  const s = Number(subtotal) || 0;
  return shippingMode(mode) === 'prepaid' ? s > PREPAID_FREE_ABOVE : s >= COD_FREE_FROM;
}

function isMissingTable(error) {
  const msg = String((error && error.message) || '');
  const code = String((error && error.code) || '');
  return code === '42P01' || (/product_free_delivery/.test(msg) && /(does not exist|schema cache|not find)/i.test(msg));
}

/** The free-delivery slugs among `slugs` (lower-cased). Missing table → empty. */
async function freeDeliveryFor(db, slugs) {
  const list = [...new Set((slugs || []).map(cleanSlug).filter(Boolean))];
  if (!db || !list.length) return new Set();
  const { data, error } = await db.from(TABLE).select('slug').or(list.map((s) => `slug.ilike.${s}`).join(','));
  if (error) {
    if (!isMissingTable(error)) console.error('[free-delivery] lookup:', error.message);
    return new Set();
  }
  return new Set((data || []).map((r) => String(r.slug).toLowerCase()));
}

/** Every free-delivery slug, sorted. Missing table → []. */
async function allFreeDelivery(db) {
  const out = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await db.from(TABLE).select('slug').order('slug').range(from, from + 999);
    if (error) {
      if (isMissingTable(error)) return out;
      throw new Error(error.message);
    }
    for (const row of data || []) out.push(String(row.slug).toLowerCase());
    if (!data || data.length < 1000) break;
  }
  return out;
}

/**
 * Shipping in rupees for a priced cart: free above ₹399 prepaid / from ₹499 on
 * COD, or with any free-delivery book. `mode` defaults to COD, the dearer rule.
 */
function orderShipping(cart, subtotal, mode = 'cod') {
  if (freeByAmount(subtotal, mode)) return 0;
  if ((cart || []).some((i) => i && i._free_delivery === true)) return 0;
  return SHIPPING_FEE;
}

module.exports = {
  TABLE, FREE_SHIPPING_THRESHOLD, PREPAID_FREE_ABOVE, COD_FREE_FROM, SHIPPING_FEE,
  isMissingTable, freeDeliveryFor, allFreeDelivery, orderShipping, shippingMode, freeByAmount,
};
