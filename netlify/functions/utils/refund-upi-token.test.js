const test = require('node:test');
const assert = require('node:assert/strict');
const { signRefundUpiToken, verifyRefundUpiToken } = require('./refund-upi-token');
const { signReviewToken } = require('./review-token');

function withSecret(value, fn) {
  const keys = ['REFUND_UPI_LINK_SECRET', 'REVIEW_LINK_SECRET', 'ADMIN_SECRET'];
  const saved = keys.map(k => [k, process.env[k]]);
  for (const k of keys) delete process.env[k];
  if (value) process.env.ADMIN_SECRET = value;
  try { return fn(); }
  finally { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('a token verifies for the order it was minted for and nothing else', () => {
  withSecret('a-secret-long-enough', () => {
    const token = signRefundUpiToken('IC-R-20260910-ABCDE');
    assert.ok(token);
    assert.equal(verifyRefundUpiToken('IC-R-20260910-ABCDE', token), true);
    assert.equal(verifyRefundUpiToken('IC-R-20260910-ZZZZZ', token), false);
  });
});

test('a garbage or empty token never verifies', () => {
  withSecret('a-secret-long-enough', () => {
    assert.equal(verifyRefundUpiToken('IC-R-1', ''), false);
    assert.equal(verifyRefundUpiToken('IC-R-1', 'x'), false);
    assert.equal(verifyRefundUpiToken('IC-R-1', 'x'.repeat(24)), false);
  });
});

test('with no secret configured nothing is minted and nothing verifies', () => {
  // Fails closed: the endpoint refuses to send a link it cannot sign, rather
  // than mailing out one that lets anyone name a payout target.
  withSecret('', () => {
    assert.equal(signRefundUpiToken('IC-R-1'), '');
    assert.equal(verifyRefundUpiToken('IC-R-1', ''), false);
    assert.equal(verifyRefundUpiToken('IC-R-1', 'anything'), false);
  });
});

test('a review token cannot be replayed as a refund-UPI token', () => {
  // Both derive from ADMIN_SECRET, so the labels are what keep a link that
  // authorises a review from also authorising a payout target.
  withSecret('a-secret-long-enough', () => {
    const orderId = 'IC-20260910-ABCDE';
    assert.notEqual(signReviewToken(orderId), signRefundUpiToken(orderId));
    assert.equal(verifyRefundUpiToken(orderId, signReviewToken(orderId)), false);
  });
});
