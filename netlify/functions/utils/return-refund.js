/**
 * Return-refund helpers — shared by request-return (customer picks a method) and
 * the prepaid auto-refund trigger.
 *
 *   resolvePaymentType(order)  → 'prepaid' | 'cod' | 'partial_cod'
 *   refundBasePaise(order)     → what the customer actually paid (the refund base)
 *   mintWalletCredit(...)      → a ready-to-use SCRATCH- store-credit code
 *
 * Payment-type signal: at return time order.status is 'delivered', so we can't
 * use status. Instead:
 *   • cart_items[0]._payment.mode === 'partial_cod'  → partial_cod
 *   • razorpay_payment_id present (Razorpay pay_… OR PhonePe txn id, which the
 *     PhonePe webhook stores in the SAME column) → prepaid
 *   • otherwise → cod (COD orders are inserted with razorpay_payment_id = null)
 */

const WALLET_BONUS_RUPEES = 50;                 // extra store credit for choosing wallet
const WALLET_EXPIRY_DAYS  = 180;                // 6 months to spend it

function paymentMeta(order) {
  return (Array.isArray(order?.cart_items) && order.cart_items[0] && order.cart_items[0]._payment) || {};
}

function resolvePaymentType(order) {
  if (paymentMeta(order).mode === 'partial_cod') return 'partial_cod';
  return order?.razorpay_payment_id ? 'prepaid' : 'cod';
}

/** Rupees the customer actually paid, and therefore should get back. */
function refundBasePaise(order) {
  const amountPaise = Math.max(0, Number(order?.amount_paise) || 0);
  if (resolvePaymentType(order) === 'partial_cod') {
    const meta = paymentMeta(order);
    const fullPaise = Math.round((Number(meta.full_total) || 0) * 100);
    if (fullPaise > 0) return fullPaise;
    // Fallback: deposit already paid (amount_paise) + cash balance collected.
    return amountPaise + Math.round((Number(meta.balance) || 0) * 100);
  }
  // prepaid → they paid amount_paise online; cod → they paid amount_paise cash.
  return amountPaise;
}

function randomCode() {
  // Avoid ambiguous chars (0/O, 1/I) so customers can type it reliably.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `SCRATCH-${s}`;
}

/**
 * Mint a store-credit code the customer can type straight into the checkout
 * coupon box (checkout validates SCRATCH- codes server-side and applies them as
 * a discount). It's created already 'scratched' so it's immediately redeemable,
 * with min_subtotal = its own value so no credit is forfeited.
 *
 * @returns {Promise<{code:string, value_paise:number, expires_at:string}>}
 */
async function mintWalletCredit(supabase, { order, valuePaise }) {
  const value = Math.max(100, Math.round(valuePaise));           // ≥ ₹1
  const expiresAt = new Date(Date.now() + WALLET_EXPIRY_DAYS * 24 * 3600 * 1000).toISOString();
  const row = {
    customer_phone:     order.customer_phone || null,
    customer_email:     order.customer_email || null,
    customer_name:      order.customer_name  || null,
    value_paise:        value,
    min_subtotal_paise: value,                                   // spend ≥ credit → full value realised
    status:             'scratched',                             // immediately usable (no scratch step)
    source_order_id:    order.razorpay_order_id || order.id,
    scratched_at:       new Date().toISOString(),
    expires_at:         expiresAt,
  };

  // Retry a couple of times on the (rare) unique-code collision.
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = randomCode();
    const { error } = await supabase.from('scratch_cards').insert({ ...row, code });
    if (!error) return { code, value_paise: value, expires_at: expiresAt };
    if (error.code !== '23505') throw error;                     // not a dup → real failure
  }
  throw new Error('Could not mint a unique wallet code after several attempts');
}

module.exports = {
  WALLET_BONUS_RUPEES,
  WALLET_EXPIRY_DAYS,
  resolvePaymentType,
  refundBasePaise,
  mintWalletCredit,
};
