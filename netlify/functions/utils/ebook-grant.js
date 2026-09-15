/**
 * Granting an eBook: the one place an entitlement is ever written.
 *
 * Shared by ebook-verify-payment.js (the browser came back) and
 * razorpay-webhook.js (it did not). Both paths must reach the same row, because
 * a customer who paid and then closed the tab has still paid — for a physical
 * order that is recoverable by looking at the parcel, but a digital one has
 * nothing to look at. The webhook is what makes "paid but tab closed" safe.
 *
 * Idempotent on payment_id: whichever path arrives second is a no-op rather
 * than a duplicate row or an error.
 */

/**
 * @returns {{ ok: true, slug: string, already?: boolean } | { ok: false, error: string }}
 */
async function grantEbook(db, { slug, userId, email, paymentId, orderId, amountPaise }) {
  if (!slug || !userId || !paymentId) return { ok: false, error: 'missing grant fields' };

  const { data: existing } = await db.from('ebook_entitlements')
    .select('id').eq('payment_id', paymentId).maybeSingle();
  if (existing) return { ok: true, slug, already: true };

  const { error } = await db.from('ebook_entitlements').insert({
    slug,
    user_id: userId,
    email: email || null,
    order_id: orderId || null,
    payment_id: paymentId,
    amount_paise: amountPaise || null,
  });

  if (error) {
    // A unique violation means the other path won the race a millisecond ago.
    // That is success, not failure — the customer has the book either way.
    if (/duplicate key|unique constraint/i.test(error.message)) {
      return { ok: true, slug, already: true };
    }
    return { ok: false, error: error.message };
  }
  return { ok: true, slug };
}

module.exports = { grantEbook };
