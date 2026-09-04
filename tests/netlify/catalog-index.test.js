const test = require('node:test');
const assert = require('node:assert');
const { buildIndex, slugFromUrl } = require('../../scripts/build-catalog-index');

test('a book is indexed under its computed slug and its url slug', () => {
  const index = buildIndex([{
    title: 'The Deal', price_inr: '299', shopify_id: 'gid://x/12345',
    url: 'https://inkandchai.in/product/the-deal-elle-kennedy/',
  }]);
  assert.deepStrictEqual(index['the-deal-12345'], { title: 'The Deal', price: 299, slug: 'the-deal-12345' });
  // Hand-curated CUSTOM listings are only reachable by their url slug, so the
  // cart resolver has to find them under that name too.
  assert.deepStrictEqual(index['the-deal-elle-kennedy'], { title: 'The Deal', price: 299, slug: 'the-deal-elle-kennedy' });
});

test('books with no usable price are left out', () => {
  const index = buildIndex([
    { title: 'Free', price_inr: '0', shopify_id: 'a1111' },
    { title: 'Junk', price_inr: 'n/a', shopify_id: 'b2222' },
  ]);
  assert.deepStrictEqual(Object.keys(index), []);
});

test('shipping restrictions are stored only when a book actually has one', () => {
  const index = buildIndex([
    { title: 'Plain', price_inr: '199', shopify_id: 'c3333', tags: 'fiction, bestseller' },
    { title: 'Limited', price_inr: '199', shopify_id: 'd4444', tags: 'no-ship-delhi' },
  ]);
  // Storing an empty object on every entry tripled the index for nothing.
  assert.strictEqual('shippingRestrictions' in index['plain-c3333'], false);
});

test('the committed index is present and usable', () => {
  // pricing.js require()s this file on the checkout path; an empty or missing
  // one silently prices every catalogue book as "not in catalogue".
  const index = require('../../data/catalog-index.json');
  const slugs = Object.keys(index);
  assert.ok(slugs.length > 2000, `expected a full catalogue, got ${slugs.length} slugs`);
  const sample = index[slugs[0]];
  assert.ok(sample.slug && sample.title && sample.price > 0);
});

test('slugFromUrl only accepts product URLs', () => {
  assert.strictEqual(slugFromUrl('https://inkandchai.in/product/atomic-habits/'), 'atomic-habits');
  assert.strictEqual(slugFromUrl('/product/Some-Book?x=1'), 'some-book');
  assert.strictEqual(slugFromUrl('https://inkandchai.in/books/'), '');
  assert.strictEqual(slugFromUrl(''), '');
});
