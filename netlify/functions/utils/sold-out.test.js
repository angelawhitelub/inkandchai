'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCartPrices } = require('./pricing');
const { findShippingRestriction, findSoldOut } = require('./shipping-restrictions');
const { soldOutSlugs, markFeedSoldOut, markJsonLdSoldOut } = require('./sold-out');

// A real catalogue slug, so the static price path is the one exercised.
const SLUG = 'our-perfect-storm-by-carley-fortune-rtune';

/** Any chain of supabase-js calls on `table` resolves to its rows. */
function fakeDb(tables) {
  return {
    from(table) {
      const q = new Proxy({}, {
        get(_, k) {
          if (k === 'then') return (res, rej) => Promise.resolve({ data: tables[table] || [], error: null }).then(res, rej);
          if (k === 'maybeSingle') return () => Promise.resolve({ data: (tables[table] || [])[0] || null, error: null });
          return () => q;
        },
      });
      return q;
    },
  };
}

const line = (slug = SLUG, extra = {}) => ({ slug, url: `/product/${slug}/`, qty: 1, price: 1, ...extra });

test('a book with stock 0 on an active override is flagged sold out; checkout refuses it', async () => {
  const db = fakeDb({ product_overrides: [{ slug: SLUG, is_active: true, stock_qty: 0, price_inr: null }] });
  const { cart } = await resolveCartPrices([line()], db);
  assert.equal(cart[0]._sold_out, true);
  const r = findShippingRestriction(cart, { pincode: '110006' });
  assert.equal(r.blocked, true);
  assert.equal(r.code, 'product_sold_out');
  assert.match(r.error, /is sold out\. Please remove it from your cart/);
});

test('no stock set, stock above 0, or a disabled override: not sold out', async () => {
  for (const row of [{ stock_qty: null }, { stock_qty: 4 }, { stock_qty: 0, is_active: false }]) {
    const db = fakeDb({ product_overrides: [{ slug: SLUG, is_active: true, price_inr: null, ...row }] });
    const { cart } = await resolveCartPrices([line()], db);
    assert.equal(cart[0]._sold_out, undefined, JSON.stringify(row));
    assert.equal(findSoldOut(cart).blocked, false);
  }
});

test('the browser cannot clear or fake the flag', async () => {
  const sold = fakeDb({ product_overrides: [{ slug: SLUG, is_active: true, stock_qty: 0 }] });
  assert.equal((await resolveCartPrices([line(SLUG, { _sold_out: false })], sold)).cart[0]._sold_out, true);
  const inStock = fakeDb({ product_overrides: [] });
  assert.equal((await resolveCartPrices([line(SLUG, { _sold_out: true })], inStock)).cart[0]._sold_out, undefined);
});

test('several sold-out books are named together', () => {
  const r = findSoldOut([{ title: 'A', _sold_out: true }, { title: 'B' }, { title: 'C', _sold_out: true }]);
  assert.equal(r.error, 'A, C are sold out. Please remove them from your cart to continue.');
  assert.equal(r.sold_out.length, 2);
});

test('soldOutSlugs lower-cases and skips disabled rows', async () => {
  const set = await soldOutSlugs(fakeDb({ product_overrides: [
    { slug: 'Fingersmith-91165', stock_qty: 0, is_active: true },
    { slug: 'off', stock_qty: 0, is_active: false },
    { slug: 'neg', stock_qty: -2, is_active: true },
  ] }));
  assert.deepEqual([...set].sort(), ['fingersmith-91165', 'neg']);
});

test('feed.xml: only the sold-out items say out of stock', () => {
  const xml = `<rss><channel>
    <item>
      <g:id>can-t-hurt-me-hardcover-53629</g:id>
      <g:availability>in stock</g:availability>
    </item>
    <item>
      <g:id>our-perfect-storm-by-carley-fortune-rtune</g:id>
      <g:availability>in stock</g:availability>
    </item>
  </channel></rss>`;
  const { xml: out, changed } = markFeedSoldOut(xml, new Set(['can-t-hurt-me-hardcover-53629']));
  assert.equal(changed, 1);
  assert.match(out, /53629<\/g:id>\s*<g:availability>out of stock</);
  assert.match(out, /rtune<\/g:id>\s*<g:availability>in stock</);
  assert.equal(markFeedSoldOut(xml, new Set()).xml, xml);
});

test('product JSON-LD: InStock becomes OutOfStock', () => {
  assert.equal(markJsonLdSoldOut('{"availability": "https://schema.org/InStock"}'), '{"availability": "https://schema.org/OutOfStock"}');
});
