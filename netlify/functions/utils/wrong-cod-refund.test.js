'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { assess, botContext, refundsEnabled, ten } = require('./wrong-cod-refund');

const base = {
  id: 'uuid-1',
  razorpay_order_id: 'IC-20260916-0R36N',
  customer_phone: '9876543210',
  wrong_cod_paise: 36820,
  wrong_cod_refund_at: null,
  status: 'delivered',
};
const at = (over) => ({ ...base, ...over });

test('an order without the marker is never refundable, whatever the customer says', () => {
  assert.equal(assess(at({ wrong_cod_paise: 0 })).verdict, 'not-affected');
  assert.equal(assess(at({ wrong_cod_paise: null })).verdict, 'not-affected');
  assert.equal(assess({}).verdict, 'not-affected');
  assert.equal(assess(null).verdict, 'not-affected');
});

test('delivered + marked + untouched is the only refundable state', () => {
  assert.equal(assess(base).verdict, 'refundable');
  assert.equal(assess(base).amountPaise, 36820);
});

test('an undelivered order is never refunded — this is the whole point of the gate', () => {
  for (const status of ['shipped', 'out_for_delivery', 'paid', 'rto', 'cancelled', 'in_transit']) {
    const v = assess(at({ status }));
    assert.notEqual(v.verdict, 'refundable', `${status} must not be refundable`);
  }
});

test('an undelivered order is told to accept the parcel and pay, and the tool is forbidden', () => {
  const ctx = botContext(at({ status: 'shipped' }));
  assert.match(ctx, /NOT delivered/);
  assert.match(ctx, /do accept the parcel and pay/i);
  assert.match(ctx, /Do NOT call refund_wrong_cod/);
  assert.match(ctx, /₹368\.20/);
});

test('a delivered order is told to refund, without asking for a UPI id', () => {
  const ctx = botContext(base);
  assert.match(ctx, /DELIVERED/);
  assert.match(ctx, /call the refund_wrong_cod tool NOW/);
  assert.match(ctx, /Do not ask for a UPI id/);
});

test('an already-refunded order is never refunded twice', () => {
  const v = assess(at({ wrong_cod_refund_at: '2026-09-20T10:00:00Z', wrong_cod_refund_ref: 'rfnd_X' }));
  assert.equal(v.verdict, 'already-done');
  assert.equal(v.ref, 'rfnd_X');
  const ctx = botContext(at({ wrong_cod_refund_at: '2026-09-20T10:00:00Z', wrong_cod_refund_ref: 'rfnd_X' }));
  assert.match(ctx, /ALREADY been refunded/);
  assert.match(ctx, /rfnd_X/);
  assert.match(ctx, /Do NOT call refund_wrong_cod again/);
});

test('a row already in a refund state is left to the gateway', () => {
  for (const status of ['refunded', 'partially_refunded', 'refund_pending', 'refund_failed']) {
    assert.equal(assess(at({ status })).verdict, 'in-refund', status);
  }
});

test('one customer cannot pull another customer\'s refund', () => {
  assert.equal(assess(base, { phone: '919876543210' }).verdict, 'refundable');
  assert.equal(assess(base, { phone: '+91 98765 43210' }).verdict, 'refundable');
  assert.equal(assess(base, { phone: '9111111111' }).verdict, 'not-yours');
  assert.equal(botContext(base, { phone: '9111111111' }), '');
});

test('a delivery the courier never collected on can be vetoed', () => {
  assert.equal(assess(base, { remittanceKnown: false }).verdict, 'not-collected');
  assert.equal(assess(base, { remittanceKnown: true }).verdict, 'refundable');
  assert.equal(assess(base, { remittanceKnown: null }).verdict, 'refundable');
});

test('the kill switch stops payouts but still admits the mistake', () => {
  assert.equal(assess(base, { enabled: false }).verdict, 'disabled');
  const ctx = botContext(base, { enabled: false });
  assert.match(ctx, /wrongly printed as Cash on Delivery/);
  assert.doesNotMatch(ctx, /call the refund_wrong_cod tool NOW/);
});

test('refunds default to on, and only an explicit off word stops them', () => {
  assert.equal(refundsEnabled(undefined), true);
  assert.equal(refundsEnabled(''), true);
  assert.equal(refundsEnabled('1'), true);
  for (const off of ['0', 'off', 'false', 'no', 'OFF']) assert.equal(refundsEnabled(off), false, off);
});

test('the context never tells the customer they might be mistaken', () => {
  for (const status of ['delivered', 'shipped']) {
    const ctx = botContext(at({ status }));
    assert.match(ctx, /This is our mistake/);
    assert.match(ctx, /Never suggest the customer is mistaken/);
  }
});

test('phone comparison uses the last ten digits only', () => {
  assert.equal(ten('+91 98765 43210'), '9876543210');
  assert.equal(ten('919876543210'), '9876543210');
  assert.equal(ten(null), '');
});
