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

/**
 * Payment kinds the gateway cannot fully reverse, so the refund has to be
 * pushed by hand to a destination the customer gives us.
 *
 * `partial_cod` belongs here and used not to. Only the deposit was captured
 * online -- typically 10% -- while the balance arrived as cash to the courier.
 * refundBasePaise() correctly returns the FULL amount the customer paid, so
 * routing that to the gateway asked it to return money it never took: the
 * customer would have seen roughly a tenth of their refund and the rest would
 * have gone nowhere, with the panel reporting "Prepaid (auto)" the whole time.
 *
 * Retracting to a single manual payout for the whole amount, rather than
 * auto-refunding the deposit and paying the remainder by hand, is deliberate.
 * PhonePe allows only ONE partial refund per order through the API, so a split
 * spends that single shot on the smaller half and leaves the larger half with
 * no mechanism at all if anything then goes wrong. One transfer, one record,
 * one thing to reconcile.
 */
const MANUAL_PAYOUT_TYPES = new Set(['cod', 'partial_cod']);

function needsManualPayout(paymentType) {
  return MANUAL_PAYOUT_TYPES.has(String(paymentType || '').toLowerCase());
}

const UPI_RE     = /^[a-z0-9.\-_]{2,256}@[a-z]{2,64}$/i;
const ACCOUNT_RE = /^\d{9,18}$/;                  // Indian account numbers
const IFSC_RE    = /^[A-Z]{4}0[A-Z0-9]{6}$/i;     // 5th char is always zero

/**
 * Validate where a manual refund should be sent: a UPI id, or a full bank
 * triplet. Returns `{ ok: true, destination }` or `{ ok: false, error }`.
 *
 * A partial triplet is an error rather than a silent fall-through -- someone
 * who typed an account number and no IFSC has told us they want a bank
 * transfer, and accepting the request without one would store a destination
 * nobody can pay.
 */
function resolvePayoutDestination(input = {}) {
  const upiId   = String(input.upiId || '').trim();
  const account = String(input.bankAccount || '').replace(/[\s-]/g, '');
  const ifsc    = String(input.bankIfsc || '').trim().toUpperCase();
  const holder  = String(input.bankHolder || '').trim();

  if (upiId) {
    if (!UPI_RE.test(upiId)) return { ok: false, error: 'That UPI ID does not look right. It should read like name@bank.' };
    return { ok: true, destination: { upiId, bankAccount: '', bankIfsc: '', bankHolder: '' } };
  }

  if (account || ifsc || holder) {
    if (!ACCOUNT_RE.test(account)) return { ok: false, error: 'Enter your bank account number (9-18 digits), or a UPI ID instead.' };
    if (!IFSC_RE.test(ifsc))       return { ok: false, error: 'Enter a valid IFSC code (like HDFC0001234).' };
    if (holder.length < 2)         return { ok: false, error: 'Enter the account holder\u2019s name as it appears on the bank account.' };
    return { ok: true, destination: { upiId: '', bankAccount: account, bankIfsc: ifsc, bankHolder: holder.slice(0, 80) } };
  }

  return { ok: false, error: 'Enter a UPI ID, or your bank account number and IFSC, so we can send the refund.' };
}

/** How to describe a payout destination to the person making the transfer. */
function payoutLabel(dest = {}) {
  if (dest.upiId) return `UPI ${dest.upiId}`;
  if (dest.bankAccount) return `A/c ${dest.bankAccount} · ${dest.bankIfsc} · ${dest.bankHolder}`;
  return '';
}

/** The same, for the customer: they know their own details, so mask the account. */
function payoutLabelMasked(dest = {}) {
  if (dest.upiId) return `UPI ${dest.upiId}`;
  if (dest.bankAccount) {
    return `your bank account ending ${dest.bankAccount.slice(-4)} (${dest.bankIfsc})`;
  }
  return 'the details you gave us';
}

module.exports = {
  WALLET_BONUS_RUPEES,
  WALLET_EXPIRY_DAYS,
  resolvePaymentType,
  refundBasePaise,
  mintWalletCredit,
  MANUAL_PAYOUT_TYPES,
  needsManualPayout,
  resolvePayoutDestination,
  payoutLabel,
  payoutLabelMasked,
};
