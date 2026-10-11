'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { injectNewArrivals, latestCustomBooks } = require('./new-arrivals');

const LANDING = '<main><section class="grid">\n      <a class="card" href="/product/our-perfect-storm/">old</a></section></main>';
const CATEGORY = '<div class="lp-grid"><a href="/product/our-perfect-storm/" class="ah-card">old</a></div>';
const BOOKS = [
  { slug: 'strange-pictures', title: 'Strange Pictures by Uketsu', author: 'Uketsu', price: 359, image: '/spimg/x.webp' },
  { slug: 'our-perfect-storm', title: 'dup', author: '', price: 1, image: '' },
  { slug: 'gone-book', title: 'Gone', author: '', price: 1, image: '' },
];

test('new admin books go first on /new-arrivals/, in its card markup', () => {
  const { html, added } = injectNewArrivals(LANDING, BOOKS, { deleted: new Set(['gone-book']) });
  assert.equal(added, 1);
  assert.ok(html.indexOf('strange-pictures') < html.indexOf('our-perfect-storm'));
  assert.match(html, /<a class="card" href="\/product\/strange-pictures\/">[\s\S]*<strong>Strange Pictures by Uketsu<\/strong>[\s\S]*₹ 359/);
});

test('and on /new-arrivals-2026/, in its own markup', () => {
  const { html, added } = injectNewArrivals(CATEGORY, BOOKS);
  assert.equal(added, 2);
  assert.match(html, /^<div class="lp-grid"><a href="\/product\/strange-pictures\/" class="ah-card">/);
});

test('an unknown page or no books: unchanged', () => {
  assert.equal(injectNewArrivals('<html></html>', BOOKS).added, 0);
  assert.equal(injectNewArrivals(LANDING, []).html, LANDING);
});

test('newest first, overrides and sold out applied, display title used', async () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://abc.supabase.co';
  const rows = [
    { slug: 'trust-fall', title: 'Trust Fall: From the no. 1 bestselling author of Better than the Movies', author: 'Lynn Painter', price_inr: 299, image_url: 'https://x/a.webp' },
    { slug: 'sold', title: 'Sold', author: '', price_inr: 100, image_url: 'https://x/b.webp' },
    { slug: 'no-cover', title: 'No Cover', author: '', price_inr: 100, image_url: '' },
  ];
  const db = {
    from(table) {
      const q = { select: () => q, eq: () => q, not: () => q, order: () => q, in: () => q,
        limit: async () => ({ data: rows, error: null }),
        then: (res) => Promise.resolve({ data: table === 'product_overrides' ? [{ slug: 'trust-fall', price_inr: 279, is_active: true }] : [], error: null }).then(res) };
      return q;
    },
  };
  const books = await latestCustomBooks(db, { soldOut: new Set(['sold']) });
  assert.deepEqual(books.map((b) => [b.slug, b.title, b.price]), [['trust-fall', 'Trust Fall by Lynn Painter', 279]]);
});
