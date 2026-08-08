const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PAYMENT_FAILED_REASON, NEVER_CAPTURED_ERROR,
  isPaymentFailedCancellation, neverCapturedPayment,
} = require('./payment-failed');

// The bug this guards: orders are pre-inserted before payment, so a FAILED
// payment leaves a 'cancelled' row behind. It used to also carry the failed
// attempt's txn id, so the refund cron — which sweeps
// (status in OWED_STATUSES) + (payment id is not 'pay_...') — kept submitting it
// and PhonePe kept answering "Order not in completed state". 89 orders stuck.

test('a failed-payment cancellation is recognised from the marker', () => {
  assert.ok(isPaymentFailedCancellation({ cancellation_reason: PAYMENT_FAILED_REASON }));
  assert.ok(neverCapturedPayment({ status: 'cancelled', cancellation_reason: PAYMENT_FAILED_REASON }));
});

test('the marker is matched case-insensitively', () => {
  assert.ok(isPaymentFailedCancellation({ cancellation_reason: 'Payment_Failed' }));
});

test('a genuine cancellation of a PAID order is still owed a refund', () => {
  const paidThenCancelled = {
    status: 'cancelled',
    razorpay_payment_id: 'OM2608070304157812629550V',
    cancellation_reason: 'Customer changed their mind',
  };
  assert.equal(neverCapturedPayment(paidThenCancelled), false);
  assert.equal(isPaymentFailedCancellation(paidThenCancelled), false);
});

test('an order with no cancellation reason at all is not assumed unpaid', () => {
  // Conservative by design: guessing "unpaid" here would silently swallow a
  // refund the customer is actually owed.
  assert.equal(neverCapturedPayment({ status: 'cancelled', cancellation_reason: null }), false);
  assert.equal(neverCapturedPayment({ status: 'refund_failed' }), false);
  assert.equal(neverCapturedPayment({}), false);
  assert.equal(neverCapturedPayment(null), false);
});

test('legacy rows are recognised from PhonePe\'s own rejection', () => {
  // The 89 rows already in the DB predate the marker; their proof is the error.
  assert.ok(neverCapturedPayment({
    status: 'refund_failed',
    refund_last_error: 'Order not in completed state',
  }));
});

test('the permanent-error test does NOT match transient lookup failures', () => {
  // "not found" can be a glitch. Treating it as permanent would abandon a real
  // refund, which is the one failure mode worse than retrying too often.
  for (const err of ['Order not found', 'Transaction not found', 'HTTP 500',
                     'Insufficient balance', 'Refund already initiated']) {
    assert.equal(NEVER_CAPTURED_ERROR.test(err), false, err);
    assert.equal(neverCapturedPayment({ refund_last_error: err }), false, err);
  }
});

test('the permanent-error test matches the real PhonePe wording', () => {
  for (const err of ['Order not in completed state',
                     'ORDER NOT IN COMPLETED STATE',
                     'Refund failed: order not in completed state.']) {
    assert.ok(NEVER_CAPTURED_ERROR.test(err), err);
  }
});

// ── The cron's actual candidate filter, reproduced ──────────────────────────
const OWED_STATUSES = ['refund_pending', 'refund_failed', 'cancelled', 'rto', 'undelivered', 'lost'];
const isPhonePePayment = (pid) => Boolean(pid) && !String(pid).startsWith('pay_');
const wouldRetry = (o) =>
  OWED_STATUSES.includes(o.status) && isPhonePePayment(o.razorpay_payment_id) && !neverCapturedPayment(o);

test('the exact row that started this is no longer retried', () => {
  const stuck = {
    razorpay_order_id: 'IC-20260806-CQQ0C',
    status: 'refund_failed',
    razorpay_payment_id: 'OM2608070301449024282768V',
    amount_paise: 25900,
    refund_attempts: 12,
    refund_last_error: 'Order not in completed state',
  };
  assert.equal(wouldRetry(stuck), false);
});

test('the same customer\'s genuinely paid order is untouched by the guard', () => {
  const paidAndShipped = {
    razorpay_order_id: 'IC-20260806-7IUXZ',
    status: 'shipped',
    razorpay_payment_id: 'OM2608070304157812629550V',
    amount_paise: 25900,
  };
  assert.equal(neverCapturedPayment(paidAndShipped), false);
});

test('an RTO order that IS owed a refund still reaches the retry loop', () => {
  assert.ok(wouldRetry({ status: 'rto', razorpay_payment_id: 'OM123', amount_paise: 25900 }));
});

test('a Razorpay order never enters the PhonePe loop', () => {
  assert.equal(wouldRetry({ status: 'cancelled', razorpay_payment_id: 'pay_abc123' }), false);
});

test('a failed payment with no stored payment id is filtered out twice over', () => {
  // After the webhook fix the id is left null, so it fails isPhonePePayment too.
  const afterFix = { status: 'cancelled', razorpay_payment_id: null,
                     cancellation_reason: PAYMENT_FAILED_REASON };
  assert.equal(wouldRetry(afterFix), false);
  assert.equal(isPhonePePayment(afterFix.razorpay_payment_id), false);
  assert.ok(neverCapturedPayment(afterFix));
});
