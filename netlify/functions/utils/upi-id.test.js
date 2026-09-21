'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUpiId, requireUpiId, UPI_REQUIRED_REASON } = require('./upi-id');
const { isDefinitelyCod } = require('./order-payment-kind');

// ── Two halves, deliberately ────────────────────────────────────────────────
// normalizeUpiId reports on what was typed and treats a blank field as "nothing
// supplied". requireUpiId is the same check with blank promoted to an error.
// The split exists because three flows share this file and only one of them
// has no other way to move the money.

test('a real handle is accepted and normalised', () => {
  for (const v of ['9876543210@ybl', 'name@okaxis', 'karthik.maran@okhdfcbank', 'abc_123@paytm']) {
    assert.equal(normalizeUpiId(v).ok, true, `${v} should be accepted`);
  }
  assert.equal(normalizeUpiId('  9876543210 @ybl ').value, '9876543210@ybl');
});

test('normalizeUpiId leaves the blank case to its caller', () => {
  // submit-refund-upi and the WhatsApp bot share this function. Making blank an
  // error here would have changed their behaviour too, which is why the strict
  // rule is a second function rather than a flag on this one.
  for (const v of ['', '   ', null, undefined]) {
    const r = normalizeUpiId(v);
    assert.equal(r.ok, false);
    assert.equal(r.reason, '', 'no reason means nothing was supplied');
  }
});

test('requireUpiId refuses a blank field, with something to act on', () => {
  for (const v of ['', '   ', null, undefined]) {
    const r = requireUpiId(v);
    assert.equal(r.ok, false, `${JSON.stringify(v)} must not pass`);
    assert.equal(r.reason, UPI_REQUIRED_REASON);
    assert.ok(r.reason.length > 0);
  }
});

test('the blank-field message gives the reason and an example, not "required"', () => {
  // A customer is being asked for a payment address in the middle of reporting
  // that a parcel arrived short. "This field is required" reads as an obstacle;
  // the reason it exists is the only thing that makes it reasonable.
  assert.match(UPI_REQUIRED_REASON, /Cash on Delivery/i);
  assert.match(UPI_REQUIRED_REASON, /@ybl/);
});

test('a malformed handle keeps its own message', () => {
  // Telling someone who typed an email address that the field is required just
  // sends them back to type the same email again.
  const r = requireUpiId('someone@gmail.com');
  assert.equal(r.ok, false);
  assert.match(r.reason, /email address/i);
  assert.notEqual(r.reason, UPI_REQUIRED_REASON);
});

test('requireUpiId passes a good handle through untouched', () => {
  const r = requireUpiId('  9876543210 @ybl ');
  assert.deepEqual(r, { ok: true, value: '9876543210@ybl', reason: '' });
});


// ── Which orders are asked ──────────────────────────────────────────────────
// report-missing-books only runs on DELIVERED orders, and asks only where the
// gateway cannot send the money back. isDefinitelyCod draws that line.

test('a delivered legacy COD row is COD, exactly as a shipped one is', () => {
  // A rule that stopped at 'shipped' answered "not COD" for every legacy row
  // the report form could ever see, so the handle was collected and dropped.
  const legacy = { razorpay_payment_id: null, payment_status: null };
  assert.equal(isDefinitelyCod({ ...legacy, status: 'shipped' }), true);
  assert.equal(isDefinitelyCod({ ...legacy, status: 'delivered' }), true);
});

test('widening to delivered weakened no guard', () => {
  assert.equal(isDefinitelyCod({ status: 'delivered', shipment_payment_type: 'prepaid' }), false);
  assert.equal(isDefinitelyCod({ status: 'delivered', shipment_payment_type: 'partial_cod' }), false);
  assert.equal(isDefinitelyCod({ status: 'delivered', cart_items: [{ _payment: { mode: 'prepaid' } }] }), false);
  assert.equal(isDefinitelyCod({ status: 'delivered', cart_items: [{ _payment: { mode: 'partial_cod' } }] }), false);
  assert.equal(isDefinitelyCod({ status: 'delivered', cart_items: [{ _payment: { payment_type: 'online' } }] }), false);
  assert.equal(isDefinitelyCod({ status: 'delivered', razorpay_payment_id: 'pay_123' }), false);
  // A PhonePe payment id lives in the same column and does not start with pay_.
  assert.equal(isDefinitelyCod({ status: 'delivered', razorpay_payment_id: 'OMO2609181234567890' }), false);
  assert.equal(isDefinitelyCod({ status: 'delivered', payment_status: 'prepaid_pending' }), false);
});

test('a status that never shipped is not a legacy COD row', () => {
  for (const status of ['pending', 'paid', 'confirmed', 'cancelled', 'refunded', 'rto', '']) {
    assert.equal(
      isDefinitelyCod({ status, razorpay_payment_id: null, payment_status: null }), false,
      `${status || '(empty)'} must not read as COD`
    );
  }
});
