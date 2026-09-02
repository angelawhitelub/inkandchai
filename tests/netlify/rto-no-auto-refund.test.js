'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { _test } = require('../../netlify/functions/phonepe-retry-refunds-background');
const { isManualRefundOnly, OWED_STATUSES } = _test;

test('an RTO order is never auto-refunded by the retry job', () => {
  // The parcel came back, so the customer is owed the amount MINUS both courier
  // legs. This job only knows how to refund order.amount_paise in full, so it
  // must not issue at all -- 66 orders went back at 100% before this guard.
  assert.equal(isManualRefundOnly({ status: 'rto' }), true);
  assert.equal(isManualRefundOnly({ status: 'RTO' }), true);
});

test('states where a full refund IS correct stay automatic', () => {
  // A cancelled order was never shipped and a lost parcel is our fault: the
  // customer is owed everything, and holding those back would strand refunds.
  for (const status of ['cancelled', 'refund_pending', 'refund_failed', 'lost', 'undelivered']) {
    assert.equal(isManualRefundOnly({ status }), false, `${status} must stay automatic`);
  }
});

test('rto is still scanned, so a refund already in flight completes', () => {
  // The guard sits after the reconcile step on purpose. Dropping 'rto' from the
  // scan instead would strand money that is already moving, and the customer
  // would never be told it landed.
  assert.ok(OWED_STATUSES.includes('rto'));
});

test('a missing or odd status never blocks a legitimate refund', () => {
  for (const order of [{}, { status: null }, { status: '' }, null, undefined]) {
    assert.equal(isManualRefundOnly(order), false);
  }
});
