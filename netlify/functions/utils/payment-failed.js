// ── "This order was never paid" ──────────────────────────────────────────────
// Orders are pre-inserted at checkout (phonepe-create-order) BEFORE the customer
// pays, so an abandoned or declined payment leaves a real row behind. When the
// gateway reports FAILED the row is cancelled — and for a while it also inherited
// the failed attempt's transaction id, which made it look exactly like a paid
// order that was cancelled afterwards. The refund cron sweeps on
// (status in OWED_STATUSES) + (payment id is not a Razorpay 'pay_' id), so those
// rows were repeatedly submitted for refund and repeatedly rejected by PhonePe
// with "Order not in completed state" — 89 of them by 2026-08-09.
//
// The marker lives in `cancellation_reason`, a column that already exists, so no
// migration is needed. Both the writer (phonepe-webhook) and every reader must
// use these helpers rather than repeating the string.

const PAYMENT_FAILED_REASON = 'payment_failed';

// PhonePe's rejection when the original payment never completed. It is permanent
// for that order — no amount of retrying can make an uncaptured payment
// refundable — so it must stop the retry loop rather than burn the attempt cap.
// Deliberately ONLY this message: "order not found" / "transaction not found"
// can also come from a lookup glitch, and treating those as permanent would
// silently abandon a refund that is genuinely owed.
const NEVER_CAPTURED_ERROR = /not in completed state/i;

function isPaymentFailedCancellation(order) {
  return String(order?.cancellation_reason || '').toLowerCase() === PAYMENT_FAILED_REASON;
}

// True when we can tell, without calling the gateway, that this order never took
// money and therefore owes no refund. Deliberately conservative: it must never
// return true for an order that might have been captured, or a real refund would
// be silently skipped.
function neverCapturedPayment(order) {
  if (!order) return false;
  if (isPaymentFailedCancellation(order)) return true;
  // Legacy rows written before the marker existed: cancelled/refund_failed, and
  // the gateway itself has already told us the payment was never completed.
  if (NEVER_CAPTURED_ERROR.test(String(order.refund_last_error || ''))) return true;
  return false;
}

module.exports = {
  PAYMENT_FAILED_REASON,
  NEVER_CAPTURED_ERROR,
  isPaymentFailedCancellation,
  neverCapturedPayment,
};
