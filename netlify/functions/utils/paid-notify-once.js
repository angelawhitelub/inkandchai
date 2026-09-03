'use strict';

/**
 * Exactly one "payment received" notification per order.
 *
 * A PhonePe payment lands twice: once as the server-to-server webhook, once as
 * phonepe-verify-status when the customer's browser comes back. Both are
 * deliberate — either can go missing — but both also notified, and their guard
 * was a read-then-write:
 *
 *   both read status = 'pending_phonepe'
 *   both see "not paid yet, so this transition is mine"
 *   both write 'paid'
 *   both email the customer and the owner
 *
 * That only ever worked when one finished before the other started. Within the
 * same second it does nothing, which is how one order produced two owner
 * emails at 12:10 AM.
 *
 * The fix is to make claiming the notification a single conditional UPDATE, so
 * Postgres decides the winner. The loser gets zero rows back and stays quiet.
 */

// Statuses a PhonePe order holds before its payment is confirmed.
const PRE_PAYMENT_STATUSES = ['pending_phonepe', 'pending_partial_phonepe'];

/**
 * Claim the right to send the payment notifications for this order.
 *
 * @returns {Promise<{won: boolean, via: string, error?: string}>}
 *   won === true   this caller notifies
 *   won === false  someone else already did, or the claim failed — stay silent
 *
 * Two strategies, because the dedicated column may not exist yet:
 *
 *   'stamp'  — sets paid_notified_at where it IS NULL. Independent of the
 *              status write, so it works whatever order the two paths run in.
 *   'status' — falls back to the status transition itself, conditional on the
 *              row still being pre-payment. Weaker (a caller that has already
 *              written 'paid' cannot use it) but needs no migration.
 */
async function claimPaidNotify(supabase, orderId, targetStatus) {
  if (!supabase || !orderId) return { won: false, via: 'invalid' };

  const { data, error } = await supabase
    .from('orders')
    .update({ paid_notified_at: new Date().toISOString() })
    .eq('id', orderId)
    .is('paid_notified_at', null)
    .select('id');

  if (!error) return { won: !!(data && data.length), via: 'stamp' };

  // Anything other than "that column does not exist" is a real failure. Do NOT
  // notify on it: a duplicate email is a smaller harm than a storm of them.
  if (!String(error.message || '').includes('paid_notified_at')) {
    return { won: false, via: 'error', error: error.message };
  }

  if (!targetStatus) return { won: false, via: 'no-column' };

  const fallback = await supabase
    .from('orders')
    .update({ status: targetStatus })
    .eq('id', orderId)
    .in('status', PRE_PAYMENT_STATUSES)
    .select('id');

  if (fallback.error) return { won: false, via: 'status-error', error: fallback.error.message };
  return { won: !!(fallback.data && fallback.data.length), via: 'status' };
}

module.exports = { claimPaidNotify, PRE_PAYMENT_STATUSES };
