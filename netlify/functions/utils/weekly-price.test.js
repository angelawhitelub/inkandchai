'use strict';
const test = require('node:test');
const assert = require('node:assert');
const wp = require('./weekly-price');

const IST = (iso) => Date.parse(iso + '+05:30');

test('the week starts Monday 00:00 IST', () => {
  assert.strictEqual(wp.weekKey(IST('2026-11-16T00:00:00')), '2026-11-16');   // Monday midnight
  assert.strictEqual(wp.weekKey(IST('2026-11-15T23:59:59')), '2026-11-09');   // Sunday night
  assert.strictEqual(wp.weekKey(IST('2026-11-22T12:00:00')), '2026-11-16');   // the next Sunday
  // 20:00 UTC on Sunday is already Monday 01:30 in India.
  assert.strictEqual(wp.weekKey(Date.parse('2026-11-15T20:00:00Z')), '2026-11-16');
  assert.strictEqual(wp.nextChangeAt(IST('2026-11-15T10:00:00')).toISOString(), '2026-11-15T18:30:00.000Z');
});

test('only books at ₹300 or more are cut, by ₹10 or ₹20', () => {
  const now = IST('2026-11-17T10:00:00');
  assert.strictEqual(wp.weeklyPrice('any-book', 299, now), 299);
  assert.strictEqual(wp.weeklyPrice('any-book', 149, now), 149);
  for (const base of [300, 349, 499, 1299]) {
    const cut = base - wp.weeklyPrice('any-book', base, now);
    assert.ok(cut === 10 || cut === 20, `cut ${cut} on ${base}`);
  }
  assert.strictEqual(wp.weeklyPrice('', 499, now), 499);
  assert.strictEqual(wp.weeklyPrice('x', null, now), null);
});

test('the pick holds all week and roughly half the books get each cut', () => {
  const mon = IST('2026-11-16T00:00:00');
  const sun = IST('2026-11-22T23:59:00');
  let tens = 0;
  let moved = 0;
  for (let i = 0; i < 2000; i++) {
    const slug = `book-${i}`;
    assert.strictEqual(wp.cutFor(slug, mon), wp.cutFor(slug, sun));
    if (wp.cutFor(slug, mon) === 10) tens++;
    if (wp.cutFor(slug, mon) !== wp.cutFor(slug, IST('2026-11-23T00:00:00'))) moved++;
  }
  assert.ok(tens > 850 && tens < 1150, `${tens} of 2000 on ₹10`);
  assert.ok(moved > 700, `${moved} books changed cut at the next Monday`);
});

test('the slug is read the same from a URL, a path or any case', () => {
  const now = Date.now();
  const c = wp.cutFor('the-book-ab', now);
  assert.strictEqual(wp.cutFor('/product/The-Book-AB/', now), c);
  assert.strictEqual(wp.cutFor('THE-BOOK-AB', now), c);
});

test('page JSON-LD and currentItem keep their own number spelling', () => {
  const now = Date.now();
  const p = wp.weeklyPrice('s', 499, now);
  assert.strictEqual(wp.patchJsonLdPrices('{"offers": {"price": 499.0, "priceCurrency": "INR"}}', 's', now),
    `{"offers": {"price": ${p}.0, "priceCurrency": "INR"}}`);
  assert.strictEqual(wp.patchJsonLdPrices('{"price":499}', 's', now), `{"price":${p}}`);
  assert.strictEqual(wp.patchJsonLdPrices('{"price": 249.0}', 's', now), '{"price": 249.0}');
  const js = 'let currentItem = {"id": "/product/s/", "price": 499.0, "img": "x"}; var related = [{"price": 599.0}];';
  const out = wp.patchCurrentItem(js, 's', now);
  assert.ok(out.includes(`"price": ${p}.0, "img"`));
  assert.ok(out.includes('[{"price": 599.0}]'), 'only the current book is touched');
  assert.strictEqual(wp.patchCurrentItem('const currentItem = {"id":"/product/s/","price":499,"qty":1};', 's', now),
    `const currentItem = {"id":"/product/s/","price":${p},"qty":1};`);
});

test('feeds: <g:sale_price> when present, else <g:price>; MRP untouched', () => {
  const now = Date.now();
  const a = wp.weeklyPrice('book-a', 369, now);
  const b = wp.weeklyPrice('book-b', 450, now);
  const xml = `<rss><channel><link>https://inkandchai.in</link>
    <item><g:id>book-a</g:id><g:link>https://inkandchai.in/product/book-a/</g:link><g:price>369.00 INR</g:price></item>
    <item><g:id>cp-book-b</g:id><g:link>https://inkandchai.in/product/book-b/</g:link><g:price>799.00 INR</g:price>
      <g:sale_price>450.00 INR</g:sale_price></item>
    <item><g:id>book-c</g:id><g:link>https://inkandchai.in/product/book-c/</g:link><g:price>199.00 INR</g:price></item>
  </channel></rss>`;
  const { xml: out, changed } = wp.patchFeedXml(xml, now);
  assert.strictEqual(changed, 2);
  assert.ok(out.includes(`<g:price>${a}.00 INR</g:price>`));
  assert.ok(out.includes('<g:price>799.00 INR</g:price>'));
  assert.ok(out.includes(`<g:sale_price>${b}.00 INR</g:sale_price>`));
  assert.ok(out.includes('<g:price>199.00 INR</g:price>'));
});

test('overrides JSON: price_inr cut per slug, MRP and low prices left alone', () => {
  const now = Date.now();
  const doc = {
    overrides: [{ slug: 'x-1', price_inr: 499, original_price_inr: 899 }, { slug: 'x-2', price_inr: 250 }, { slug: 'x-3', price_inr: null }],
    custom_products: [{ slug: 'x-4', price_inr: '350' }],
    deleted: ['gone'],
  };
  const out = wp.patchOverridesJson(doc, now);
  assert.strictEqual(out.overrides[0].price_inr, wp.weeklyPrice('x-1', 499, now));
  assert.strictEqual(out.overrides[0].original_price_inr, 899);
  assert.strictEqual(out.overrides[1].price_inr, 250);
  assert.strictEqual(out.overrides[2].price_inr, null);
  assert.strictEqual(out.custom_products[0].price_inr, wp.weeklyPrice('x-4', 350, now));
  assert.deepStrictEqual(out.deleted, ['gone']);
  assert.strictEqual(doc.overrides[0].price_inr, 499, 'the input is not mutated');
});

test('the till sells at the weekly price and records the base', async () => {
  const { resolveCartPrices } = require('./pricing');
  const slug = 'our-perfect-storm-by-carley-fortune-rtune';   // ₹499 in the catalogue
  const r = await resolveCartPrices([{ url: `/product/${slug}/`, qty: 2, price: 1 }], null);
  const p = wp.weeklyPrice(slug, 499);
  assert.ok(p === 479 || p === 489);
  assert.strictEqual(r.cart[0].price, p);
  assert.strictEqual(r.cart[0]._base_price, 499);
  assert.strictEqual(r.subtotal, p * 2);
});

test('titles: the book own price only, never "₹499+" style copy', () => {
  const now = Date.now();
  const p = wp.weeklyPrice('s', 369, now);
  assert.strictEqual(wp.patchTitlePrice('Whistler | Buy Online @ ₹369 | Free Shipping | Ink & Chai', 's', now),
    `Whistler | Buy Online @ ₹${p} | Free Shipping | Ink & Chai`);
  assert.strictEqual(wp.patchTitlePrice('Whistler | ₹369 | Ink & Chai', 's', now), `Whistler | ₹${p} | Ink & Chai`);
  assert.strictEqual(wp.patchTitlePrice('Free delivery on ₹499+ | Ink & Chai', 's', now), 'Free delivery on ₹499+ | Ink & Chai');
  assert.strictEqual(wp.patchJsonLdPrices('"text": "Whistler is available on inkandchai.in for ₹369. Prices"', 's', now),
    `"text": "Whistler is available on inkandchai.in for ₹${p}. Prices"`);
});
