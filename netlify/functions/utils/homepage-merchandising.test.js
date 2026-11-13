'use strict';

// Removed (410) and browse-hidden books must not appear in the homepage
// best-sellers row, even though their past orders still exist.

const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateBestsellers } = require('../homepage-merchandising')._test;

test('removed books are left out by slug, and by title when the line has no slug', () => {
  const orders = [
    { cart_items: [{ slug: 'belonging-a-journey-of-love-by-sonia-gandhi', title: 'Belonging', qty: 5 }] },
    { cart_items: [{ title: 'Belonging: A Journey of Love', qty: 2 }] },
    { cart_items: [{ slug: 'atomic-habits', title: 'Atomic Habits', qty: 1 }] },
  ];
  const exclude = {
    slugs: new Set(['belonging-a-journey-of-love-by-sonia-gandhi']),
    titles: new Set(['belonging a journey of love']),
  };
  const out = aggregateBestsellers(orders, exclude);
  assert.deepEqual(out.map((r) => r.slug || r.title), ['atomic-habits']);
  assert.equal(aggregateBestsellers(orders).length, 3, 'nothing excluded without a list');
});
