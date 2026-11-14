'use strict';
/**
 * New-customer offer (owner, 14 Nov 2026): 5% off a customer's FIRST order.
 *
 * Listed prices never change -- the product page, the feed and Merchant Center
 * keep one price -- the 5% is a discount at the till, like a coupon. It never
 * stacks: the customer gets whichever single discount is worth more (this, a
 * coupon, a scratch card or a site sale). That rule lives in `better()`.
 *
 * "First order" = no earlier order under this phone number (last 10 digits)
 * or e-mail. Checkout attempts that were never paid (PhonePe pre-inserts its
 * rows; failed payments are cancelled with reason payment_failed) do not
 * count; a cancelled or returned order does, so place-cancel-reorder cannot
 * earn it twice. A lookup error means NO discount (never give money away on a
 * guess); the checkout page then shows the till's total via the usual 409.
 *
 * The tills (create-order, phonepe-create-order, cod-order) decide. The
 * checkout page asks first-order-offer only to show the same total up front.
 */

const FIRST_ORDER = Object.freeze({ code: 'FIRST5', percent: 5, label: 'New customer 5% off' });

// Rows that never became an order (utils/gst-sales-report NEVER_INVOICED).
const NOT_AN_ORDER = new Set([
  'pending', 'online_pending', 'pending_phonepe', 'pending_partial_phonepe', 'payment_failed', 'failed',
]);

const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s,()@]+@[^\s,()@]+\.[^\s,()@]+$/.test(e);

function countsAsOrder(o) {
  if (NOT_AN_ORDER.has(String(o.status || '').toLowerCase())) return false;
  if (String(o.cancellation_reason || '').toLowerCase() === 'payment_failed') return false;
  return true;
}

/**
 * true / false, or null when it cannot tell (no usable phone or e-mail, or the
 * lookup failed). Only `false` earns the discount.
 */
async function hasOrderedBefore(supabase, { phone, email } = {}) {
  const p10 = last10(phone);
  const em = normEmail(email);
  const ors = [];
  // customer_phone is stored raw (+91, spaces), so widen on the last four
  // digits in SQL and settle the match on the last ten in JS.
  if (p10.length === 10) ors.push(`customer_phone.ilike.%${p10.slice(-4)}`);
  if (em && validEmail(em)) ors.push(`customer_email.ilike.${em}`);
  if (p10.length !== 10) return null; // the phone is what checkout always has
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('customer_phone, customer_email, status, cancellation_reason')
      .or(ors.join(','))
      .limit(500);
    if (error) { console.warn('[first-order] lookup failed:', error.message); return null; }
    return (data || []).some((o) => countsAsOrder(o)
      && (last10(o.customer_phone) === p10 || (em && normEmail(o.customer_email) === em)));
  } catch (e) {
    console.warn('[first-order] lookup failed:', e && e.message);
    return null;
  }
}

/** 5% of the subtotal, rounded down like every other percentage discount. */
function firstOrderDiscount(subtotal) {
  return Math.max(0, Math.floor((Number(subtotal) || 0) * FIRST_ORDER.percent / 100));
}

/** { code, discount, source:'first_order', label } for a new customer, else a zero discount. */
async function firstOrderOffer(supabase, customer, subtotal) {
  const none = { code: '', discount: 0, source: '' };
  const discount = firstOrderDiscount(subtotal);
  if (discount <= 0 || !customer) return none;
  const before = await hasOrderedBefore(supabase, { phone: customer.phone, email: customer.email });
  if (before !== false) return none;
  return { code: FIRST_ORDER.code, discount, source: 'first_order', label: FIRST_ORDER.label };
}

/** The single better discount; the one already chosen wins a tie. */
function better(current, firstHit) {
  if (!(firstHit && firstHit.discount > 0)) return current;
  return current && current.discount >= firstHit.discount ? current : firstHit;
}

module.exports = { FIRST_ORDER, hasOrderedBefore, firstOrderDiscount, firstOrderOffer, better, countsAsOrder, last10 };
