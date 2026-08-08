// ── Merchant refund ids that can be found again ──────────────────────────────
// Every refund path used to mint `REFUND-<orderId>-<Date.now()>` and store it in
// orders.refund_id, overwriting whatever was there. When attempt #1 SUCCEEDED
// but the success wasn't recorded, attempt #2 minted a fresh id, PhonePe refused
// it ("Total refund amount is more than forward amount" — the forward amount was
// already consumed), and that failed id replaced the good one. The only handle
// on the completed refund was gone: getRefundStatus(stored id) answers
// REFUND_TRANSACTION_NOT_FOUND, and PhonePe's order-status payload carries no
// refund fields at all, so both detection paths went blind. 90 orders ended up
// showing REFUND FAILED for money that had already gone back to the customer.
//
// The fix is to derive the id from the attempt number instead of the clock, so
// the complete set of ids an order could ever have used is reconstructible from
// refund_attempts alone — no new column, and no way to lose a successful refund
// again. Re-issuing still uses a NEW id (a merchantRefundId PhonePe has already
// rejected cannot be retried), but every earlier id stays enumerable and must be
// checked before any re-issue.
//
// Legacy timestamp ids are not reconstructible. Rows that only ever used those
// have to be reconciled from a PhonePe refunds export.

const ATTEMPT_PREFIX = 'A';

// The id for a specific attempt. `attempt` is 0-based and matches the value of
// orders.refund_attempts BEFORE that attempt is made.
function refundIdForAttempt(displayId, attempt) {
  return `REFUND-${displayId}-${ATTEMPT_PREFIX}${Number(attempt) || 0}`;
}

// True for ids this scheme produced (as opposed to the old `-<epoch ms>` form).
function isAttemptRefundId(refundId, displayId) {
  return new RegExp(`^REFUND-${escapeRe(String(displayId))}-${ATTEMPT_PREFIX}\\d+$`).test(String(refundId || ''));
}

// Every merchant refund id this order may have used, newest first: whatever is
// stored now, plus one per attempt already made. Callers must check all of them
// before issuing a new refund — a COMPLETED among them means the money is
// already back and re-issuing would be a double refund attempt.
function knownRefundIds(order) {
  const displayId = order?.razorpay_order_id || order?.id;
  if (!displayId) return [];
  const attempts = Math.max(0, Number(order?.refund_attempts) || 0);
  const ids = [];
  if (order?.refund_id) ids.push(String(order.refund_id));
  // Cap the reconstruction so a runaway attempts value can't fan out into
  // hundreds of gateway lookups.
  for (let i = Math.min(attempts, 25); i >= 0; i--) ids.push(refundIdForAttempt(displayId, i));
  return [...new Set(ids)];
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = { refundIdForAttempt, isAttemptRefundId, knownRefundIds, ATTEMPT_PREFIX };
