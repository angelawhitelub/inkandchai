const test = require('node:test');
const assert = require('node:assert/strict');
const { refundSentence, refundSentenceShort } = require('../../netlify/functions/utils/order-cancelled-notification');

const prepaid = { amount_paise: 35900, razorpay_payment_id: 'pay_ABC123' };
const phonepe = { amount_paise: 35900, razorpay_payment_id: 'OM2608281705' };
const cod     = { amount_paise: 35900, razorpay_payment_id: null };
const zero    = { amount_paise: 0, razorpay_payment_id: 'pay_ABC123' };

test('a COD customer is never told a refund is coming', () => {
  for (const fn of [refundSentence, refundSentenceShort]) {
    const s = fn(cod, { ok: true, nextStatus: 'refunded' });   // even if a refund object is somehow passed
    assert.match(s, /not charged/i);
    assert.doesNotMatch(s, /refund (has been|is being) (issued|processed)/i);
  }
});

test('an order that captured nothing is treated as unpaid', () => {
  assert.match(refundSentence(zero, { ok: true, nextStatus: 'refunded' }), /not charged/i);
});

test('a confirmed refund is stated plainly, with the amount and a timeline', () => {
  const s = refundSentence(prepaid, { ok: true, nextStatus: 'refunded' });
  assert.match(s, /has been issued/);
  assert.match(s, /Rs\. 359/);
  assert.match(s, /3-7 working days/);
});

test('an unconfirmed refund is promised, never claimed as already issued', () => {
  // Gateway error, still pending, RTO, or already in flight — all reach here.
  // { ok: true, nextStatus: 'refund_pending' } is the PhonePe case: the gateway
  // accepted the refund but has not settled it. That is NOT "issued" yet.
  for (const refund of [{ ok: false }, null, undefined, { skipped: 'already-refunded' },
                        { skipped: 'rto-no-auto-refund' }, { ok: true, nextStatus: 'refund_pending' }]) {
    const s = refundSentence(phonepe, refund);
    assert.match(s, /is being processed/);
    assert.doesNotMatch(s, /has been issued/);
  }
});

test('skipRefund (payment never captured) says nothing was charged', () => {
  assert.match(refundSentence(prepaid, null, { skipRefund: true }), /not charged/i);
  assert.match(refundSentenceShort(prepaid, null, { skipRefund: true }), /not charged/i);
});

test('both gateways get the same wording — the customer does not care which', () => {
  assert.equal(refundSentence(prepaid, { ok: true, nextStatus: 'refunded' }), refundSentence(phonepe, { ok: true, nextStatus: 'refunded' }));
});
