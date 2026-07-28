const test = require('node:test');
const assert = require('node:assert/strict');

const { slugFromItem, aggregateBestsellers } = require('../../netlify/functions/homepage-merchandising')._test;

test('extracts product slugs from current and legacy cart items', () => {
  assert.equal(slugFromItem({ slug: 'atomic-habits' }), 'atomic-habits');
  assert.equal(slugFromItem({ url: '/product/psychology-of-money/?x=1' }), 'psychology-of-money');
});

test('bestsellers use sold quantity and merge repeated product slugs', () => {
  const result = aggregateBestsellers([
    { cart_items: [{ slug: 'book-a', title: 'Book A', qty: 2, price: 199 }] },
    { cart_items: [{ url: '/product/book-a/', title: 'Book A New Title', qty: 3, price: 199 }] },
    { cart_items: [{ slug: 'book-b', title: 'Book B', qty: 4, price: 299 }] },
  ]);
  assert.equal(result[0].slug, 'book-a');
  assert.equal(result[0].qty, 5);
  assert.equal(result[1].slug, 'book-b');
});
