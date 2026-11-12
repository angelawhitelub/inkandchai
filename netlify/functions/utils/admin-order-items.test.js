'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { booksOf } = require('../admin-order-items');

test('book lines only, in order, with qty and slug; payment markers and blanks dropped', () => {
  const order = { cart_items: JSON.stringify([
    { title: 'Anxious People', qty: 2, price: 299, url: '/product/anxious-people/' },
    { _payment: { mode: 'partial_cod' } },
    { name: 'Vibe', quantity: '1' },
    { title: '  ' },
  ]) };
  assert.deepEqual(booksOf(order), [
    { title: 'Anxious People', qty: 2, price: 299, slug: 'anxious-people' },
    { title: 'Vibe', qty: 1, price: null, slug: null },
  ]);
  assert.deepEqual(booksOf({ cart_items: 'not json' }), []);
});
