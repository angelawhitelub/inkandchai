const test = require('node:test');
const assert = require('node:assert/strict');
const { discountForProductCoupon } = require('./product-coupons');

const cart = [
  { slug: 'musafir', price: 249, qty: 2 },
  { slug: 'other', price: 500, qty: 1 },
];

test('percentage discount only uses eligible product lines', () => {
  const result = discountForProductCoupon({ code: 'TEN', discount_type: 'percent', discount_value: 10, product_slugs: ['musafir'], is_active: true }, cart);
  assert.equal(result.discount, 49);
});

test('fixed discount is once per order and capped at eligible subtotal', () => {
  const result = discountForProductCoupon({ code: 'FLAT', discount_type: 'fixed', discount_value: 600, product_slugs: ['musafir'], is_active: true }, cart);
  assert.equal(result.discount, 498);
});

test('does not discount a cart without a selected product', () => {
  const result = discountForProductCoupon({ code: 'TEN', discount_type: 'percent', discount_value: 10, product_slugs: ['missing'], is_active: true }, cart);
  assert.equal(result.discount, 0);
  assert.equal(result.reason, 'product_not_eligible');
});
