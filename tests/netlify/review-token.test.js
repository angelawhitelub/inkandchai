'use strict';
const test = require('node:test');
const assert = require('node:assert');

const MOD = '../../netlify/functions/utils/review-token';

function withSecret(secret, fn) {
  const prevReview = process.env.REVIEW_LINK_SECRET;
  const prevAdmin = process.env.ADMIN_SECRET;
  delete process.env.REVIEW_LINK_SECRET;
  if (secret === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = secret;
  delete require.cache[require.resolve(MOD)];
  try { return fn(require(MOD)); }
  finally {
    if (prevReview === undefined) delete process.env.REVIEW_LINK_SECRET; else process.env.REVIEW_LINK_SECRET = prevReview;
    if (prevAdmin === undefined) delete process.env.ADMIN_SECRET; else process.env.ADMIN_SECRET = prevAdmin;
    delete require.cache[require.resolve(MOD)];
  }
}

test('a token verifies only against the order it was signed for', () => {
  withSecret('unit-test-secret', ({ signReviewToken, verifyReviewToken }) => {
    const token = signReviewToken('IC-20260825-ABCDE');
    assert.ok(token.length > 0);
    assert.equal(verifyReviewToken('IC-20260825-ABCDE', token), true);
    assert.equal(verifyReviewToken('IC-20260825-ZZZZZ', token), false);
  });
});

test('tampered, truncated and empty tokens are rejected', () => {
  withSecret('unit-test-secret', ({ signReviewToken, verifyReviewToken }) => {
    const id = 'IC-20260825-ABCDE';
    const token = signReviewToken(id);
    assert.equal(verifyReviewToken(id, token.slice(0, -1) + 'x'), false);
    assert.equal(verifyReviewToken(id, token.slice(0, -1)), false);
    assert.equal(verifyReviewToken(id, ''), false);
    assert.equal(verifyReviewToken(id, null), false);
  });
});

test('with no secret configured it signs nothing and verifies nothing', () => {
  // Fails closed: a misconfigured deploy must not mint tokens that everyone
  // can forge, and must not accept the empty string as proof.
  withSecret(undefined, ({ signReviewToken, verifyReviewToken }) => {
    assert.equal(signReviewToken('IC-20260825-ABCDE'), '');
    assert.equal(verifyReviewToken('IC-20260825-ABCDE', ''), false);
    assert.equal(verifyReviewToken('IC-20260825-ABCDE', 'anything'), false);
  });
});

test('signing is stable across calls and distinct per order', () => {
  withSecret('unit-test-secret', ({ signReviewToken }) => {
    assert.equal(signReviewToken('IC-1'), signReviewToken('IC-1'));
    assert.notEqual(signReviewToken('IC-1'), signReviewToken('IC-2'));
  });
});
