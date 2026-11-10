const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { storeCodeDiscount, normalizePromotion } = require('./promotions');

const rows = [
  { code: 'INKLOVE10', discount_type: 'percent', discount_value: 8, min_subtotal_inr: 599, payment_methods: ['prepaid'], status: 'active' },
  { code: 'SAVE12', discount_type: 'percent', discount_value: 12, min_subtotal_inr: 999, payment_methods: ['prepaid'], status: 'paused' },
  { code: 'SAVE15', discount_type: 'percent', discount_value: 15, min_subtotal_inr: 1499, payment_methods: ['prepaid'], status: 'active', ends_at: '2026-01-01T00:00:00Z' },
  { code: 'FLAT50', discount_type: 'fixed', discount_value: 50, min_subtotal_inr: 0, max_discount_inr: null, payment_methods: ['prepaid'], status: 'active' },
  { code: 'CAPPED', discount_type: 'percent', discount_value: 20, min_subtotal_inr: 0, max_discount_inr: 100, payment_methods: ['prepaid'], status: 'active' },
].map(normalizePromotion);
const deps = { loadPromotions: async () => rows };
const now = new Date('2026-11-10T10:00:00Z');
const at = (code, subtotal) => storeCodeDiscount(code, { subtotal, now }, deps);

test('an edited rate and minimum are what the till charges', async () => {
  assert.deepEqual(await at('INKLOVE10', 1000), { code: 'INKLOVE10', discount: 80 });
  assert.deepEqual(await at('inklove10', 598), { code: '', discount: 0 }, 'under the edited minimum');
});

test('paused or past its end date -> no discount, and the built-in rate does not come back', async () => {
  assert.deepEqual(await at('SAVE12', 5000), { code: '', discount: 0 });
  assert.deepEqual(await at('SAVE15', 5000), { code: '', discount: 0 });
});

test('fixed and capped discounts', async () => {
  assert.deepEqual(await at('FLAT50', 300), { code: 'FLAT50', discount: 50 });
  assert.deepEqual(await at('CAPPED', 2000), { code: 'CAPPED', discount: 100 });
});

test('a code the store does not define is left to the till\'s own table', async () => {
  assert.equal(await at('SAVE99', 5000), null);
  assert.equal(await at('', 5000), null);
});

test('only prepaid: COD is never discounted by these codes', async () => {
  assert.deepEqual(await storeCodeDiscount('INKLOVE10', { subtotal: 1000, paymentMethod: 'cod', now }, deps), { code: '', discount: 0 });
});

test('both tills ask the store before their built-in table', () => {
  for (const f of ['create-order.js', 'phonepe-create-order.js']) {
    const src = fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
    const store = src.indexOf('await storeCodeDiscount(rawCode');
    const builtIn = f === 'create-order.js' ? src.indexOf('const staticHit = staticCouponDiscount(subtotal, rawCode)') : src.indexOf('const staticResult = couponDiscount(subtotal, rawCode)');
    assert.ok(store > 0 && builtIn > store, f);
  }
});
