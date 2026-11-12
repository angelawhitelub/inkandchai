'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { preorderChecker } = require('./preorder-hold');

// Books unreadable: both rules fall back to what checkout stamped on the lines.
const db = { from() { throw new Error('offline'); } };
const now = Date.parse('2026-11-12T10:00:00Z');
const order = (id, line) => ({ razorpay_order_id: id, created_at: '2026-11-12T09:00:00Z', cart_items: [line] });

test('a released order skips the handling hold; others stay held', async () => {
  const holdFor = await preorderChecker(db, now, { released: new Set(['IC-1']) });
  const line = { title: 'Belonging', slug: 'belonging', _handling_days: 3 };
  assert.equal(holdFor(order('IC-1', line)), null);
  assert.equal(holdFor(order('ic-2', line)).kind, 'handling');
});

test('push anyway never releases a pre-order', async () => {
  const holdFor = await preorderChecker(db, now, { released: new Set(['IC-3']) });
  const hold = holdFor(order('IC-3', { title: 'Future Book', slug: 'future-book', _release: '2026-12-01' }));
  assert.equal(hold.kind, 'preorder');
});

test('the release store reads as empty when KV is unavailable, so orders stay held', async () => {
  const { releasedOrders } = require('./handling-release');
  const set = await releasedOrders();
  assert.equal(set.size, 0);
});
