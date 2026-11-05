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

// ── Has the customer already tried again? ─────────────────────────────────────
// PhonePe's FAILED callback typically lands about 20 minutes after the attempt,
// by which time the customer has often paid on a second one. Telling them "your
// order was cancelled" then reads as losing the order they just paid for: on
// 4 Nov 2026 a customer answered it with "Please reorder" and paid a third time.
// 202 of 861 failed-payment notices in the prior 30 days went out that late.
const PLACED_STATUSES = ['paid', 'confirmed', 'cod_pending', 'partial_cod_pending', 'cod_awaiting_confirmation',
  'shipped', 'out_for_delivery', 'delivered'];

/**
 * A later order on the same phone number that really went through, or null.
 * Any trouble answers null: this only ever suppresses a message, so when unsure
 * the customer hears about the failure as they always did.
 */
async function newerOrderSince(db, order) {
  const ten = String(order?.customer_phone || '').replace(/\D/g, '').slice(-10);
  if (ten.length !== 10 || !order?.created_at) return null;
  try {
    const { data, error } = await db.from('orders')
      .select('razorpay_order_id, status, created_at')
      .or(`customer_phone.eq.${ten},customer_phone.eq.91${ten},customer_phone.eq.+91${ten}`)
      .gt('created_at', order.created_at)
      .in('status', PLACED_STATUSES)
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) return null;
    return (data && data[0]) || null;
  } catch (_) {
    return null;
  }
}

/** Sends the failed-payment cancellation unless a newer order makes it misleading. */
async function notifyPaymentFailed(db, order, send) {
  const newer = await newerOrderSince(db, order);
  if (newer) {
    console.log(`[payment-failed] no cancellation notice for ${order.razorpay_order_id}: customer has since placed ${newer.razorpay_order_id}`);
    return { sent: false, newer };
  }
  await send();
  return { sent: true };
}

module.exports = {
  PLACED_STATUSES,
  newerOrderSince,
  notifyPaymentFailed,
  PAYMENT_FAILED_REASON,
  NEVER_CAPTURED_ERROR,
  isPaymentFailedCancellation,
  neverCapturedPayment,
};
