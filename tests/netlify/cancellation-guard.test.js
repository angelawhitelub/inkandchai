const test = require('node:test');
const assert = require('node:assert');
const {
  CANCEL_MIN_AGE_DAYS, orderAgeDays, cancellationAllowed, cancellationBlocked,
} = require('../../netlify/functions/utils/cancellation-guard');

const NOW = Date.parse('2026-08-24T00:45:00Z');
const aged = (days) => ({ created_at: new Date(NOW - days * 86400000).toISOString() });

test('the guard is ten days', () => {
  assert.strictEqual(CANCEL_MIN_AGE_DAYS, 10);
});

test('blocks the real batch that went through on 24 Aug', () => {
  // Observed ages of the 71 NimbusPost "cancelled" reports in that 00:45 batch.
  for (const days of [7.61, 8.13, 8.74, 9.18, 9.64, 9.99]) {
    const v = cancellationAllowed(aged(days), { now: NOW });
    assert.strictEqual(v.allowed, false, `${days}d should be blocked`);
    assert.match(v.reason, /blocked until 10 days/);
  }
});

test('allows once genuinely past ten days', () => {
  for (const days of [10, 10.01, 14, 40]) {
    assert.strictEqual(cancellationAllowed(aged(days), { now: NOW }).allowed, true, `${days}d should pass`);
  }
});

test('exactly ten days is allowed, a hair under is not', () => {
  assert.strictEqual(cancellationAllowed(aged(10), { now: NOW }).allowed, true);
  assert.strictEqual(cancellationAllowed(aged(9.9999), { now: NOW }).allowed, false);
});

test('fails CLOSED on a missing or unparseable created_at', () => {
  // A malformed timestamp must never be a licence to cancel.
  for (const order of [{}, { created_at: null }, { created_at: '' }, { created_at: 'not-a-date' }, null, undefined]) {
    const v = cancellationAllowed(order, { now: NOW });
    assert.strictEqual(v.allowed, false, `${JSON.stringify(order)} should be blocked`);
    assert.strictEqual(v.ageDays, null);
    assert.match(v.reason, /no usable created_at/);
  }
});

test('is not fooled by a future-dated order', () => {
  assert.strictEqual(cancellationAllowed(aged(-5), { now: NOW }).allowed, false);
});

test('orderAgeDays measures from created_at', () => {
  assert.strictEqual(orderAgeDays(aged(3), NOW), 3);
  assert.strictEqual(orderAgeDays({ created_at: 'rubbish' }, NOW), null);
});

test('cancellationBlocked is the inverse', () => {
  assert.strictEqual(cancellationBlocked(aged(2), { now: NOW }), true);
  assert.strictEqual(cancellationBlocked(aged(20), { now: NOW }), false);
});

test('guard applies regardless of payment type', () => {
  const cod = { ...aged(8), shipment_payment_type: 'cod' };
  const prepaid = { ...aged(8), razorpay_payment_id: 'pay_abc123' };
  assert.strictEqual(cancellationAllowed(cod, { now: NOW }).allowed, false);
  assert.strictEqual(cancellationAllowed(prepaid, { now: NOW }).allowed, false);
});
