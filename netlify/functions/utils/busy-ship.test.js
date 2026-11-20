'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { busyFromOrders, busyShipTag, THRESHOLD } = require('./busy-ship');
const shipDates = require('../../../public/js/ship-holidays.js');

const order = (id, items) => ({ razorpay_order_id: id, cart_items: items });

test('more than 50 units of one book across orders, or in one, is busy', () => {
  const many = Array.from({ length: 51 }, (_, i) => order(`IC-${i}`, [{ slug: 'book-a', qty: 1 }]));
  const one = [order('IC-X', [{ slug: 'book-b', qty: 60 }])];
  const fifty = Array.from({ length: 50 }, (_, i) => order(`IC-C${i}`, [{ slug: 'book-c', qty: 1 }]));
  const out = busyFromOrders([...many, ...one, ...fifty]);
  assert.deepStrictEqual(out, { 'book-a': 51, 'book-b': 60 });
  assert.strictEqual(THRESHOLD, 50);
});

test('free replacements are not counted', () => {
  const repl = [order('IC-R-1', [{ slug: 'book-a', qty: 99 }])];
  assert.deepStrictEqual(busyFromOrders(repl), {});
});

test('the Worker tag is only for busy slugs', () => {
  const doc = { slugs: { 'book-a': 51 } };
  assert.match(busyShipTag(doc, 'BOOK-A'), /__iacBusyShipDays=1/);
  assert.strictEqual(busyShipTag(doc, 'book-z'), '');
  assert.strictEqual(busyShipTag(null, 'book-a'), '');
});

test('one extra day moves Ships-by by exactly one day', () => {
  const noon = Date.UTC(2026, 10, 20, 6, 30);   // 12:00 IST, after the 03:00 cutoff
  const base = shipDates.plan(noon, 0, []);
  const busy = shipDates.plan(noon, 1, []);
  assert.strictEqual(busy.ship - base.ship, 1);
  assert.strictEqual(busy.extra, 1);
});
