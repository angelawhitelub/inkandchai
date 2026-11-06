'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { holdFromReleases, preorderChecker, splitHeld } = require('./preorder-hold');

const NOW = Date.parse('2026-11-06T06:00:00Z');
const order = (...cart_items) => ({ id: 'u1', razorpay_order_id: 'IC-1', cart_items });
const LIVE = { 'the-law-of-the-sublime-by-robert-greene': '2026-11-10', 'thought-rules-by-rhonda-byrne': '2026-11-24' };

test('a line for a book still ahead of its date holds the order', () => {
  const hold = holdFromReleases(order({ slug: 'the-law-of-the-sublime-by-robert-greene', title: 'The Law of the Sublime' }), LIVE, NOW);
  assert.equal(hold.kind, 'preorder');
  assert.equal(hold.release, '2026-11-10');
  assert.match(hold.reason, /10 Nov 2026/);
  assert.match(hold.reason, /The Law of the Sublime/);
});

test('an order with no pre-order in it goes', () => {
  assert.equal(holdFromReleases(order({ slug: 'verity', title: 'Verity' }), LIVE, NOW), null);
  assert.equal(holdFromReleases({ cart_items: null }, LIVE, NOW), null);
});

test('a mixed order waits for its latest book', () => {
  const hold = holdFromReleases(order(
    { slug: 'verity', title: 'Verity' },
    { slug: 'the-law-of-the-sublime-by-robert-greene', title: 'A' },
    { slug: 'thought-rules-by-rhonda-byrne', title: 'B' },
  ), LIVE, NOW);
  assert.equal(hold.release, '2026-11-24');
  assert.deepEqual(hold.titles, ['A', 'B']);
});

test("the book's current date wins over the stamp: moved earlier is free, moved later still waits", () => {
  assert.equal(holdFromReleases(order({ slug: 'released-early', title: 'X', _release: '2026-12-25' }), LIVE, NOW), null);
  const later = holdFromReleases(order({ slug: 'thought-rules-by-rhonda-byrne', title: 'B', _release: '2026-11-07' }), LIVE, NOW);
  assert.equal(later.release, '2026-11-24');
});

test('with the books unreadable the stamp on the line still holds it', () => {
  assert.equal(holdFromReleases(order({ slug: 'x', title: 'X', _release: '2026-11-20' }), null, NOW).release, '2026-11-20');
  assert.equal(holdFromReleases(order({ slug: 'x', title: 'X', _release: '2026-11-01' }), null, NOW), null);
});

test('on release day the order is free, judged in IST', () => {
  const live = {};
  const stamped = order({ slug: 'x', title: 'X', _release: '2026-11-10' });
  assert.ok(holdFromReleases(stamped, null, Date.parse('2026-11-09T18:29:00Z')));
  assert.equal(holdFromReleases(stamped, null, Date.parse('2026-11-09T18:31:00Z')), null);
  assert.equal(holdFromReleases(stamped, live, NOW), null);
});

test('a WhatsApp order line with only a title is matched to the book', () => {
  assert.equal(holdFromReleases(order({ title: 'The Law of the Sublime', qty: 1 }), LIVE, NOW).release, '2026-11-10');
  assert.equal(holdFromReleases(order({ title: 'Verity', qty: 1 }), LIVE, NOW), null);
  assert.equal(holdFromReleases(order({ title: 'The', qty: 1 }), { 'the-secret': '2026-11-10' }, NOW), null);
});

test('payment bookkeeping lines and a cart saved as text are handled', () => {
  const text = JSON.stringify([{ _payment: { balance: 10 }, slug: 'thought-rules-by-rhonda-byrne' }, { slug: 'the-law-of-the-sublime-by-robert-greene', title: 'L' }]);
  assert.equal(holdFromReleases({ cart_items: text }, LIVE, NOW).titles[0], 'L');
  assert.equal(holdFromReleases({ cart_items: 'not json' }, LIVE, NOW), null);
});

test('preorderChecker reads the books once and falls back to stamps if that fails', async () => {
  let reads = 0;
  const db = { from: () => { reads += 1; const b = { select: () => b, or: () => b, order: () => b, range: async () => ({ data: [{ slug: 'Soon', published_on: '20 November 2026' }], error: null }) }; return b; } };
  const check = await preorderChecker(db, NOW);
  const readsAfter = reads;
  assert.equal(check(order({ slug: 'soon', title: 'S' })).release, '2026-11-20');
  assert.equal(check(order({ slug: 'other', title: 'O' })), null);
  assert.equal(reads, readsAfter);

  const broken = { from: () => { const b = { select: () => b, or: () => b, order: () => b, range: async () => ({ data: null, error: { message: 'connection reset' } }) }; return b; } };
  const fallback = await preorderChecker(broken, NOW);
  assert.equal(fallback(order({ slug: 'x', title: 'X', _release: '2026-11-20' })).release, '2026-11-20');
});

test('splitHeld separates the orders', () => {
  const a = order({ slug: 'verity' });
  const b = order({ slug: 'the-law-of-the-sublime-by-robert-greene', title: 'L' });
  const { free, held } = splitHeld([a, b], (o) => holdFromReleases(o, LIVE, NOW));
  assert.deepEqual(free, [a]);
  assert.equal(held[0].order, b);
  assert.equal(held[0].release, '2026-11-10');
});
