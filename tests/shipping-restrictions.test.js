const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseShippingRestrictionTags,
  findShippingRestriction,
  stateFromPincode,
} = require('../netlify/functions/utils/shipping-restrictions');
const { resolveCartPrices } = require('../netlify/functions/utils/pricing');

test('parses state, exact PIN, and prefix rules from product tags', () => {
  assert.deepEqual(
    parseShippingRestrictionTags('fiction, shipping-exclude-state:Delhi, shipping-exclude-state:haryana, shipping-exclude-pin:110001, shipping-exclude-pin:122*'),
    { states: ['delhi', 'haryana'], pins: ['110001', '122*'] },
  );
});

test('derives Delhi and Haryana from delivery PIN', () => {
  assert.equal(stateFromPincode('110006'), 'delhi');
  assert.equal(stateFromPincode('122001'), 'haryana');
  assert.equal(stateFromPincode('136027'), 'haryana');
  assert.equal(stateFromPincode('201301'), '');
});

test('blocks a restricted product before checkout', () => {
  const cart = [{
    title: 'Restricted Book',
    _shipping_restrictions: { states: ['delhi', 'haryana'], pins: [] },
  }];
  const result = findShippingRestriction(cart, { address: 'New Delhi, 110006' });
  assert.equal(result.blocked, true);
  assert.equal(result.code, 'product_shipping_restricted');
  assert.match(result.error, /Restricted Book cannot be delivered to Delhi/);
});

test('supports an exact PIN and wildcard prefix', () => {
  const exact = [{ title: 'Book', _shipping_restrictions: { states: [], pins: ['560001'] } }];
  const prefix = [{ title: 'Book', _shipping_restrictions: { states: [], pins: ['560*'] } }];
  assert.equal(findShippingRestriction(exact, { pincode: '560001' }).blocked, true);
  assert.equal(findShippingRestriction(prefix, { pincode: '560099' }).blocked, true);
  assert.equal(findShippingRestriction(prefix, { pincode: '400001' }).blocked, false);
});

test('allows unrestricted destinations', () => {
  const cart = [{
    title: 'Restricted Book',
    _shipping_restrictions: { states: ['delhi', 'haryana'], pins: [] },
  }];
  assert.equal(findShippingRestriction(cart, { address: 'Mumbai, Maharashtra, 400001' }).blocked, false);
});

test('authoritative price resolution carries custom-product rules into the cart', async () => {
  const supabase = {
    from(table) {
      return {
        select() { return this; },
        or() {
          return Promise.resolve(table === 'custom_products' ? {
            data: [{
              slug: 'restricted-test-book',
              title: 'Restricted Test Book',
              price_inr: '249.00',
              is_active: true,
              tags: 'fiction,shipping-exclude-state:delhi,shipping-exclude-state:haryana',
              updated_at: '2026-07-30T00:00:00Z',
            }],
          } : { data: [] });
        },
      };
    },
  };
  const priced = await resolveCartPrices([{ slug: 'restricted-test-book', qty: 1 }], supabase);
  assert.equal(priced.cart.length, 1);
  assert.deepEqual(priced.cart[0]._shipping_restrictions, {
    states: ['delhi', 'haryana'],
    pins: [],
  });
});
