const test = require('node:test');
const assert = require('node:assert/strict');
const { refundIdForAttempt, isAttemptRefundId, knownRefundIds } = require('./refund-id');

// The bug: every retry minted `REFUND-<order>-<Date.now()>` and overwrote
// orders.refund_id. Attempt #1 for IC-20260723-ET6JJ SUCCEEDED (₹189 returned on
// 31 Jul under REFUND-IC-20260723-ET6JJ-1785438317904), attempt #2 minted a new
// id, PhonePe refused it, and the failed id replaced the good one. Afterwards
// getRefundStatus(stored) answered REFUND_TRANSACTION_NOT_FOUND and the
// order-status payload had no refund fields, so the completed refund was
// invisible. 90 orders showed REFUND FAILED for money already returned.

test('the id is derived from the attempt, not the clock', () => {
  assert.equal(refundIdForAttempt('IC-20260723-ET6JJ', 0), 'REFUND-IC-20260723-ET6JJ-A0');
  assert.equal(refundIdForAttempt('IC-20260723-ET6JJ', 3), 'REFUND-IC-20260723-ET6JJ-A3');
});

test('the same attempt always produces the same id', () => {
  // The whole point: a later run can reconstruct what an earlier run used.
  assert.equal(refundIdForAttempt('IC-1', 2), refundIdForAttempt('IC-1', 2));
});

test('different attempts produce different ids', () => {
  // Re-issuing needs a fresh id — PhonePe will not reprocess one it has rejected.
  const ids = [0, 1, 2, 3].map(i => refundIdForAttempt('IC-1', i));
  assert.equal(new Set(ids).size, 4);
});

test('a missing or odd attempt number degrades to attempt 0', () => {
  assert.equal(refundIdForAttempt('IC-1'), 'REFUND-IC-1-A0');
  assert.equal(refundIdForAttempt('IC-1', null), 'REFUND-IC-1-A0');
  assert.equal(refundIdForAttempt('IC-1', NaN), 'REFUND-IC-1-A0');
});

test('attempt ids are told apart from the legacy timestamp ids', () => {
  assert.ok(isAttemptRefundId('REFUND-IC-20260723-ET6JJ-A4', 'IC-20260723-ET6JJ'));
  assert.equal(
    isAttemptRefundId('REFUND-IC-20260723-ET6JJ-1785438317904', 'IC-20260723-ET6JJ'), false);
  assert.equal(isAttemptRefundId('', 'IC-1'), false);
  assert.equal(isAttemptRefundId(null, 'IC-1'), false);
});

test('an order id containing regex metacharacters does not break the test', () => {
  assert.ok(isAttemptRefundId('REFUND-IC-CW-20260803-XY11L-A1', 'IC-CW-20260803-XY11L'));
});

// ── knownRefundIds: the guard that makes a completed refund findable ────────
test('every id an order could have used is enumerated, newest first', () => {
  const ids = knownRefundIds({ razorpay_order_id: 'IC-1', refund_attempts: 3 });
  assert.equal(ids[0], 'REFUND-IC-1-A3');
  for (const i of [0, 1, 2, 3]) assert.ok(ids.includes(`REFUND-IC-1-A${i}`), `A${i}`);
});

test('a legacy stored id is checked first and never dropped', () => {
  // These are the 90 orders whose successful refund used an unreconstructible
  // timestamp id — if we ever learn it, it must still be looked up.
  const legacy = 'REFUND-IC-20260723-ET6JJ-1785438317904';
  const ids = knownRefundIds({
    razorpay_order_id: 'IC-20260723-ET6JJ', refund_id: legacy, refund_attempts: 2,
  });
  assert.equal(ids[0], legacy);
  assert.ok(ids.includes('REFUND-IC-20260723-ET6JJ-A0'));
});

test('an order with no attempts yet still checks attempt 0', () => {
  assert.deepEqual(knownRefundIds({ razorpay_order_id: 'IC-1' }), ['REFUND-IC-1-A0']);
  assert.deepEqual(knownRefundIds({ razorpay_order_id: 'IC-1', refund_attempts: 0 }),
    ['REFUND-IC-1-A0']);
});

test('ids are de-duplicated so the same lookup is not paid for twice', () => {
  const ids = knownRefundIds({
    razorpay_order_id: 'IC-1', refund_id: 'REFUND-IC-1-A2', refund_attempts: 2 });
  assert.equal(ids.length, new Set(ids).size);
  assert.equal(ids.filter(i => i === 'REFUND-IC-1-A2').length, 1);
});

test('a runaway attempt count cannot fan out into unbounded lookups', () => {
  const ids = knownRefundIds({ razorpay_order_id: 'IC-1', refund_attempts: 9999 });
  assert.ok(ids.length <= 27, `enumerated ${ids.length} ids`);
});

test('the row id is used when there is no display id', () => {
  assert.deepEqual(knownRefundIds({ id: 'uuid-1' }), ['REFUND-uuid-1-A0']);
});

test('an order with no id at all yields nothing rather than a bad lookup', () => {
  assert.deepEqual(knownRefundIds({}), []);
  assert.deepEqual(knownRefundIds(null), []);
});

test('the real stuck order would now find its completed refund', () => {
  // Had the scheme existed, attempt #1's id would be reconstructible from
  // refund_attempts and getRefundStatus would have returned COMPLETED.
  const order = { razorpay_order_id: 'IC-20260723-ET6JJ',
                  refund_id: 'REFUND-IC-20260723-ET6JJ-A9', refund_attempts: 9 };
  const ids = knownRefundIds(order);
  assert.ok(ids.includes('REFUND-IC-20260723-ET6JJ-A0'),
    'the first attempt — the one that succeeded — must be checked');
});
