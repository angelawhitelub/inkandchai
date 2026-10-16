const test = require('node:test');
const assert = require('node:assert/strict');
const { cartSignature, recentTwin } = require('../admin-create-replacement').__test;

const NOW = Date.parse('2026-10-16T13:30:00Z');
const row = (id, secsAgo, cart) => ({ razorpay_order_id: id, created_at: new Date(NOW - secsAgo * 1000).toISOString(), cart_items: cart });
const littleLife = [{ title: 'A Little Life', qty: 1 }];

test('same books, same order, moments ago: a double submit', () => {
  assert.equal(recentTwin([row('IC-R-1', 30, littleLife)], [{ title: 'a little life ', qty: 1 }], NOW).razorpay_order_id, 'IC-R-1');
});

test('a second replacement is allowed: different books, or the same books later', () => {
  assert.equal(recentTwin([row('IC-R-1', 30, littleLife)], [{ title: 'Dark Horse', qty: 1 }], NOW), null);
  assert.equal(recentTwin([row('IC-R-1', 30, littleLife)], [{ title: 'A Little Life', qty: 2 }], NOW), null);
  assert.equal(recentTwin([row('IC-R-1', 600, littleLife)], littleLife, NOW), null);
  assert.equal(recentTwin([], littleLife, NOW), null);
});

test('book order in the cart does not matter', () => {
  assert.equal(cartSignature([{ title: 'B' }, { title: 'A', qty: 2 }]), cartSignature([{ title: 'a', qty: 2 }, { title: 'b', qty: 1 }]));
});
