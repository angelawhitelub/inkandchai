/**
 * Refund guard — eBooks are non-refundable, enforced in code.
 *
 * An eBook is delivered the instant it is paid for: the entitlement row is
 * written, a copy is watermarked with the buyer's own email and cached, and
 * they can read the whole book. There is nothing to send back. So unlike a
 * paperback, a refund here is a pure loss — the customer keeps the goods.
 *
 * This lives one level BELOW the admin endpoints on purpose. Every refund we
 * issue — the admin modal, cancel-order, update-order-status, the return
 * auto-refund — goes through issueRazorpayRefund(), so putting the check
 * there means a future code path cannot route around it by accident.
 *
 * How an eBook payment is recognised (any one is enough):
 *   1. notes.kind === 'ebook' on the PAYMENT
 *   2. notes.kind === 'ebook' on the ORDER the payment belongs to
 *   3. an ebook_entitlements row carrying that payment_id
 *
 * Razorpay copies order notes onto the payment in most flows but we do not
 * rely on it — razorpay-webhook.js merges both for the same reason.
 *
 * FAIL CLOSED. If we cannot tell what we are about to refund, we refuse. That
 * costs nothing in practice: the lookup and the refund hit the same API, so a
 * Razorpay outage that breaks the check would have broken the refund anyway.
 * The callers already record a failed refund and retry.
 */

const RZP_API = 'https://api.razorpay.com/v1';

class NonRefundableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NonRefundableError';
    this.nonRefundable = true;
  }
}

function authHeader() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error('Razorpay credentials not configured');
  return 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
}

async function rzpGet(path) {
  const res = await fetch(`${RZP_API}${path}`, { headers: { Authorization: authHeader() } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.description || `Razorpay ${path} returned ${res.status}`);
  }
  return data;
}

function isEbookNotes(notes) {
  return String(notes?.kind || '').toLowerCase() === 'ebook';
}

/**
 * Has this payment already been recorded as an eBook purchase in our own DB?
 * Best-effort: returns false when there is no client or the query errors, since
 * the Razorpay notes checks above are the authoritative ones.
 */
async function entitlementExists(supabase, paymentId) {
  if (!supabase || typeof supabase.from !== 'function') return false;
  try {
    const { data, error } = await supabase
      .from('ebook_entitlements').select('id').eq('payment_id', paymentId).maybeSingle();
    if (error) return false;
    return !!data;
  } catch { return false; }
}

const REFUSAL = 'eBooks are non-refundable — the book is delivered and readable the moment it is paid for. '
  + 'Refund it from the Razorpay dashboard if you have decided to make an exception.';

/**
 * Throw if `paymentId` paid for an eBook.
 *
 * @param {string} paymentId  Razorpay payment id ("pay_…")
 * @param {object} [opts]     { supabase } — optional client for the entitlement check
 * @throws {NonRefundableError} when the payment is an eBook purchase
 * @throws {Error} when the payment cannot be looked up (fail closed)
 */
async function assertRefundablePayment(paymentId, opts = {}) {
  const payment = await rzpGet(`/payments/${encodeURIComponent(paymentId)}`);
  if (isEbookNotes(payment?.notes)) throw new NonRefundableError(REFUSAL);

  if (payment?.order_id) {
    const order = await rzpGet(`/orders/${encodeURIComponent(payment.order_id)}`);
    if (isEbookNotes(order?.notes)) throw new NonRefundableError(REFUSAL);
  }

  if (await entitlementExists(opts.supabase, paymentId)) throw new NonRefundableError(REFUSAL);
}

module.exports = { assertRefundablePayment, NonRefundableError, REFUSAL };
