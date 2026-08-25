'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeUpiId } = require('../../netlify/functions/utils/upi-id');

test('real UPI handles are accepted', () => {
  for (const v of ['9876543210@ybl', 'name@okaxis', 'karthik.maran@okhdfcbank', 'abc_123@paytm', 'a-b@upi', 'MAHESH@ibl']) {
    assert.strictEqual(normalizeUpiId(v).ok, true, `${v} should be accepted`);
  }
});

test('surrounding and inner whitespace is stripped', () => {
  assert.strictEqual(normalizeUpiId('  9876543210 @ybl ').value, '9876543210@ybl');
});

test('an email address is rejected — it is the mistake people actually make', () => {
  const r = normalizeUpiId('someone@gmail.com');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /email address/i);
  assert.strictEqual(normalizeUpiId('a@b.co.in').ok, false);
});

test('junk is rejected with a message the customer can act on', () => {
  for (const v of ['9876543210', 'no-at-sign', '@ybl', 'a@', 'a b']) {
    const r = normalizeUpiId(v);
    assert.strictEqual(r.ok, false, `${v} should be rejected`);
    assert.ok(r.reason.length > 0, `${v} should explain itself`);
  }
});

test('an empty field is not an error — the UPI ID is optional', () => {
  for (const v of ['', '   ', null, undefined]) {
    const r = normalizeUpiId(v);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, '', 'no reason means nothing was supplied');
  }
});

test('an absurdly long value is refused before the regex sees it', () => {
  assert.match(normalizeUpiId('a'.repeat(200) + '@ybl').reason, /too long/);
});

// The endpoint stores a UPI ID only for a pure-COD order: a prepaid refund goes
// back to the instrument that paid, so keeping a handle would be collecting
// payment details we have no use for.
const { isDefinitelyCod } = require('../../netlify/functions/utils/order-payment-kind');

test('only a pure-COD order is asked to keep a UPI ID', () => {
  assert.strictEqual(isDefinitelyCod({ shipment_payment_type: 'cod' }), true);
  assert.strictEqual(isDefinitelyCod({ shipment_payment_type: 'prepaid' }), false);
  assert.strictEqual(isDefinitelyCod({ shipment_payment_type: 'partial_cod' }), false);
  assert.strictEqual(isDefinitelyCod({ status: 'partial_cod_pending' }), false);
  assert.strictEqual(isDefinitelyCod({ status: 'cod_pending' }), true);
  assert.strictEqual(isDefinitelyCod({ razorpay_payment_id: 'pay_123', status: 'delivered' }), false);
});
