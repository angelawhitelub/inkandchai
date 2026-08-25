'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { orderIdFilter, sanitizeOrderId } = require('../../netlify/functions/utils/order-id-filter');

test('a display id never reaches the uuid column', () => {
  // This is the bug: `id.eq.IC-...` makes Postgres reject the whole query with
  // "invalid input syntax for type uuid".
  const f = orderIdFilter('IC-20260812-5OZV8');
  assert.strictEqual(f, 'razorpay_order_id.eq.IC-20260812-5OZV8');
  assert.ok(!f.includes(',id.eq.'));
});

test('a real uuid still matches on both columns', () => {
  const u = '3f7c1a2e-4b5d-4c6f-8a9b-0c1d2e3f4a5b';
  assert.strictEqual(orderIdFilter(u), `razorpay_order_id.eq.${u},id.eq.${u}`);
});

test('uuid matching is case-insensitive', () => {
  const u = '3F7C1A2E-4B5D-4C6F-8A9B-0C1D2E3F4A5B';
  assert.ok(orderIdFilter(u).includes(`id.eq.${u}`));
});

test('filter syntax cannot be injected through the order id', () => {
  // A comma or a dot would otherwise be read as PostgREST filter syntax.
  const f = orderIdFilter('IC-1,status.eq.delivered');
  assert.strictEqual(f, 'razorpay_order_id.eq.IC-1statuseqdelivered');
});

test('empty and junk input yield no filter at all', () => {
  for (const v of ['', '   ', null, undefined, '.,.,']) {
    assert.strictEqual(orderIdFilter(v), '', `expected no filter for ${JSON.stringify(v)}`);
  }
});

test('order ids are length-capped', () => {
  assert.strictEqual(sanitizeOrderId('A'.repeat(200)).length, 64);
});

test('surrounding whitespace is trimmed', () => {
  assert.strictEqual(orderIdFilter('  IC-20260812-5OZV8  '), 'razorpay_order_id.eq.IC-20260812-5OZV8');
});
