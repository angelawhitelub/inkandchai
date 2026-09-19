'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { interpret, SYNCABLE, TERMINAL } = require('../xpressbees-status-sync-background').__test;

test('a cancelled shipment never cancels the order', () => {
  // 51 stale panel rows were cancelled on 19 Sep for orders already shipped
  // through iThink. Mapping that back onto status would cancel 51 live parcels.
  for (const s of ['cancelled', 'Cancelled', 'order cancelled']) {
    assert.equal(interpret(s).status, undefined, s);
    assert.equal(interpret(s).record, true, s);
  }
});

test('delivery and OFD move the order forward', () => {
  assert.deepEqual(interpret('delivered'), { status: 'delivered', moved: true });
  assert.deepEqual(interpret('Out For Delivery'), { status: 'out_for_delivery', moved: true });
  assert.deepEqual(interpret('OFD'), { status: 'out_for_delivery', moved: true });
});

test('RTO sets a status and carries no money meaning', () => {
  for (const s of ['rto', 'RTO In Transit', 'RTO Delivered', 'return to origin']) {
    const v = interpret(s);
    assert.equal(v.status, 'rto', s);
    assert.ok(!('refund' in v) && !('cancel' in v), 'nothing about money may ride on a courier scan');
  }
});

test('hub scans move the parcel but never the status', () => {
  for (const s of ['in transit', 'In-Transit', 'bagged at hub', 'reached destination hub', 'pickup done']) {
    const v = interpret(s);
    assert.equal(v.status, undefined, `${s} must not change order.status`);
    assert.equal(v.moved, true, s);
  }
});

test('pre-pickup scans change nothing at all', () => {
  for (const s of ['pending pickup', 'booked', 'Data Received', 'manifested']) {
    const v = interpret(s);
    assert.equal(v.status, undefined, s);
    assert.ok(!v.moved, `${s} means the parcel has not moved yet`);
  }
});

test('an exception is flagged for a human, not written as a status', () => {
  const v = interpret('exception');
  assert.equal(v.status, undefined);
  assert.equal(v.attention, true);
  assert.equal(interpret('undelivered').attention, true);
});

test('an unknown or empty status is recorded, never guessed at', () => {
  for (const s of ['', null, 'some new scan we have not seen']) {
    const v = interpret(s);
    assert.equal(v.status, undefined);
    assert.equal(v.record, true);
  }
});

test('the job only reads from live shipping states, and refunds are terminal', () => {
  assert.deepEqual(SYNCABLE, ['shipped', 'out_for_delivery']);
  for (const s of ['refunded', 'partially_refunded', 'refund_pending', 'refund_failed', 'delivered', 'cancelled', 'rto']) {
    assert.ok(TERMINAL.includes(s), `${s} must never be walked out of by a courier scan`);
  }
});
