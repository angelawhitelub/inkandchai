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
const FREE_SHIPPING_THRESHOLD = 499;
const SHIPPING_FEE = 40;

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

/** Shipping in rupees for a priced cart: free from ₹499, or with any free-delivery book. */
function orderShipping(cart, subtotal) {
  if (Number(subtotal) >= FREE_SHIPPING_THRESHOLD) return 0;
  if ((cart || []).some((i) => i && i._free_delivery === true)) return 0;
  return SHIPPING_FEE;
}

module.exports = { TABLE, FREE_SHIPPING_THRESHOLD, SHIPPING_FEE, isMissingTable, freeDeliveryFor, allFreeDelivery, orderShipping };
