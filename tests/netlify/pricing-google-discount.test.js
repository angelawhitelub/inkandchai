'use strict';
const test = require('node:test');
const assert = require('node:assert');

process.env.DISCOUNT_GRANT_SECRET = 'test-grant-secret';
const { resolveCartPrices } = require('../../netlify/functions/utils/pricing');
const { mintGrant } = require('../../netlify/functions/utils/google-discount');

// A real catalogue slug so the test exercises the genuine resolution path.
const SLUG = 'our-perfect-storm-by-carley-fortune-rtune';
const LIST = 499;
const cart = (qty = 1) => [{ slug: SLUG, url: `/product/${SLUG}/`, qty, price: 1 }];

test('without a grant the catalogue price stands, whatever the browser claims', async () => {
  const r = await resolveCartPrices(cart(), null);
  assert.strictEqual(r.cart[0].price, LIST);
  assert.strictEqual(r.subtotal, LIST);
});

test('a verified grant brings the price down and is recorded on the line', async () => {
  const r = await resolveCartPrices(cart(), null, { discountGrants: [mintGrant(SLUG, 367.65)] });
  assert.strictEqual(r.cart[0].price, 367.65);
  assert.strictEqual(r.cart[0]._list_price, LIST);
  assert.deepStrictEqual(r.cart[0]._google_discount, { price: 367.65, was: LIST });
  assert.strictEqual(r.subtotal, 367.65);
});

test('the discount applies per unit across the quantity', async () => {
  const r = await resolveCartPrices(cart(3), null, { discountGrants: [mintGrant(SLUG, 400)] });
  assert.strictEqual(r.subtotal, 1200);
});

test('a grant can never RAISE a price', async () => {
  for (const p of [LIST, LIST + 500, 9999]) {
    const r = await resolveCartPrices(cart(), null, { discountGrants: [mintGrant(SLUG, p)] });
    assert.strictEqual(r.cart[0].price, LIST, `grant of ${p} must not apply`);
    assert.strictEqual(r.cart[0]._google_discount, undefined);
  }
});

test('a grant for one book does not discount another', async () => {
  const r = await resolveCartPrices(cart(), null, { discountGrants: [mintGrant('some-other-book', 1)] });
  assert.strictEqual(r.cart[0].price, LIST);
});

test('a forged or corrupt grant is ignored, not honoured', async () => {
  const real = mintGrant(SLUG, 250);
  const forged = real.slice(0, -4) + 'AAAA';
  for (const g of [forged, 'garbage', '', null, {}, ['nested']]) {
    const r = await resolveCartPrices(cart(), null, { discountGrants: [g] });
    assert.strictEqual(r.cart[0].price, LIST, `${JSON.stringify(g)} must not discount`);
  }
});

test('an expired grant falls back to the ordinary price', async () => {
  const old = mintGrant(SLUG, 250, { now: Date.now() - 49 * 3600 * 1000 });
  const r = await resolveCartPrices(cart(), null, { discountGrants: [old] });
  assert.strictEqual(r.cart[0].price, LIST);
});

test('passing no grants at all behaves exactly as before', async () => {
  const a = await resolveCartPrices(cart(), null);
  const b = await resolveCartPrices(cart(), null, {});
  const c = await resolveCartPrices(cart(), null, { discountGrants: [] });
  assert.strictEqual(a.subtotal, b.subtotal);
  assert.strictEqual(b.subtotal, c.subtotal);
});
