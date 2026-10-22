const test = require('node:test');
const assert = require('node:assert');
const { rejectReason } = require('../admin-description-case');

test('accepts a change of letter case only', () => {
  assert.strictEqual(rejectReason({ slug: 'a', from: 'The Mice Are Here.', to: 'The mice are here.' }), null);
});

test('refuses anything that changes a character, not just its case', () => {
  assert.strictEqual(rejectReason({ slug: 'a', from: 'The Mice', to: 'The mice!' }), 'not a case-only change');
  assert.strictEqual(rejectReason({ slug: 'a', from: 'The Mice', to: 'The rice' }), 'not a case-only change');
  assert.strictEqual(rejectReason({ slug: 'a', from: 'Same', to: 'Same' }), 'unchanged');
  assert.strictEqual(rejectReason({ from: 'A', to: 'a' }), 'missing slug');
  assert.strictEqual(rejectReason({ slug: 'a', from: 'A' }), 'missing text');
});

test('titles and SEO lines are allowed, other columns are not', () => {
  assert.strictEqual(rejectReason({ slug: 'a', field: 'title', from: 'Gone With The Wind', to: 'Gone with the Wind' }), null);
  assert.strictEqual(rejectReason({ slug: 'a', table: 'product_overrides', field: 'title', from: 'A Of B', to: 'A of B' }), null);
  assert.strictEqual(rejectReason({ slug: 'a', field: 'price_inr', from: 'A', to: 'a' }), 'field not allowed');
  assert.strictEqual(rejectReason({ slug: 'a', table: 'product_overrides', field: 'description', from: 'A', to: 'a' }), 'field not allowed');
  assert.strictEqual(rejectReason({ slug: 'a', table: 'orders', field: 'title', from: 'A', to: 'a' }), 'unknown table');
});
