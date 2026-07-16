const test = require('node:test');
const assert = require('node:assert/strict');
const { isDefinitelyCod } = require('./order-payment-kind');

test('accepts persisted pure COD shipments', () => {
  assert.equal(isDefinitelyCod({ status: 'shipped', shipment_payment_type: 'cod' }), true);
});

test('rejects prepaid and partial-COD shipments', () => {
  assert.equal(isDefinitelyCod({ status: 'shipped', shipment_payment_type: 'prepaid' }), false);
  assert.equal(isDefinitelyCod({ status: 'shipped', shipment_payment_type: 'partial_cod' }), false);
  assert.equal(isDefinitelyCod({ status: 'shipped', cart_items: [{ _payment: { mode: 'partial_cod' } }] }), false);
});

test('rejects any legacy shipment carrying a payment marker', () => {
  assert.equal(isDefinitelyCod({ status: 'shipped', razorpay_payment_id: 'pay_123' }), false);
  assert.equal(isDefinitelyCod({ status: 'shipped', payment_status: 'prepaid_pending' }), false);
});

test('accepts the strict legacy COD signature', () => {
  assert.equal(isDefinitelyCod({ status: 'shipped', razorpay_payment_id: null, payment_status: null }), true);
});
