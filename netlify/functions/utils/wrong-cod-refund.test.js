'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { assess, botContext, refundsEnabled, ten, ownerUpiEmail } = require('./wrong-cod-refund');

const base = {
  id: 'uuid-1',
  razorpay_order_id: 'IC-20260916-0R36N',
  customer_phone: '9876543210',
  razorpay_payment_id: 'pay_abc123',
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

test('a customer who will not pay twice is offered the UPI route, not an argument', () => {
  const ctx = botContext(at({ status: 'shipped' }));
  assert.match(ctx, /IF THEY STILL WILL NOT PAY TWICE/);
  assert.match(ctx, /do NOT argue/);
  assert.match(ctx, /record_wrong_cod_upi/);
  assert.match(ctx, /₹368\.20/);
});

test('the bot may never ask for anything but a UPI id', () => {
  const ctx = botContext(at({ status: 'shipped' }));
  assert.match(ctx, /Never ask for a bank account number, IFSC, card number, OTP or CVV/);
});

test('a UPI id already on file is not asked for a second time', () => {
  const ctx = botContext(at({ status: 'shipped', wrong_cod_upi: '9876543210@ybl' }));
  assert.match(ctx, /9876543210@ybl/);
  assert.match(ctx, /Do NOT ask for it again/);
  assert.doesNotMatch(ctx, /IF THEY STILL WILL NOT PAY TWICE/);
});

test('a delivered order never asks for a UPI id — it refunds to source', () => {
  const ctx = botContext(base);
  assert.doesNotMatch(ctx, /record_wrong_cod_upi/);
  assert.match(ctx, /Do not ask for a UPI id/);
});

test('the owner email names the amount, the handle and the order', () => {
  const m = ownerUpiEmail({ order: at({ status: 'shipped', customer_name: 'Sneha', customer_phone: '9876543210', tracking_id: '14345160682132' }), amountPaise: 36820, upi: '9876543210@ybl' });
  assert.equal(m.subject, 'UPI payout needed — ₹368.20 to 9876543210@ybl (IC-20260916-0R36N)');
  for (const part of ['368.20', '9876543210@ybl', 'IC-20260916-0R36N', 'Sneha', '14345160682132']) {
    assert.ok(m.html.includes(part), `html missing ${part}`);
    assert.ok(m.text.includes(part), `text missing ${part}`);
  }
});

test('the owner email says nothing has been paid yet', () => {
  const m = ownerUpiEmail({ order: base, amountPaise: 36820, upi: 'a@ybl' });
  assert.match(m.html, /Nothing has been paid yet/);
  assert.match(m.text, /Nothing has been paid yet/);
});

test('a customer name cannot inject markup into the owner email', () => {
  const m = ownerUpiEmail({ order: at({ customer_name: '<script>alert(1)</script>' }), amountPaise: 100, upi: 'a@ybl' });
  assert.doesNotMatch(m.html, /<script>/);
  assert.match(m.html, /&lt;script&gt;/);
});

// ── The manual track and the automatic track must never both pay ─────────────
test('a customer who gave a UPI id is off the automatic track entirely', () => {
  const upi = at({ status: 'delivered', wrong_cod_upi: 'ridhimamanni2203@okhdfcbank' });
  assert.equal(assess(upi).verdict, 'upi-route');
  assert.equal(assess(upi).upi, 'ridhimamanni2203@okhdfcbank');
});

test('the UPI route wins over every state that would otherwise pay out', () => {
  for (const status of ['delivered', 'shipped', 'out_for_delivery']) {
    assert.equal(assess(at({ status, wrong_cod_upi: 'a@ybl' })).verdict, 'upi-route', status);
  }
});

test('a finished refund still reports as done, even with a UPI id on the row', () => {
  const v = assess(at({ wrong_cod_upi: 'a@ybl', wrong_cod_refund_at: '2026-09-20T08:46:46Z', wrong_cod_refund_ref: 'R1' }));
  assert.equal(v.verdict, 'already-done');
});

test('clearing the UPI id puts the order back on the automatic track', () => {
  assert.equal(assess(at({ status: 'delivered', wrong_cod_upi: null })).verdict, 'refundable');
  assert.equal(assess(at({ status: 'delivered', wrong_cod_upi: '' })).verdict, 'refundable');
});

test('the bot is told the money is going to UPI and forbidden from refunding the card', () => {
  const ctx = botContext(at({ status: 'delivered', wrong_cod_upi: 'a@ybl' }));
  assert.match(ctx, /a@ybl/);
  assert.match(ctx, /did not want to pay twice/);
  assert.match(ctx, /Do NOT ask for it again/);
  assert.match(ctx, /do NOT call refund_wrong_cod/);
  assert.match(ctx, /same money twice/);
});

// ── Free replacements: no payment to reverse, UPI is the only way back ───────
const repl = (over) => at({ razorpay_payment_id: null, wrong_cod_paise: 19900, ...over });

test('a free replacement is never called refundable, delivered or not', () => {
  for (const status of ['delivered', 'shipped', 'out_for_delivery']) {
    assert.equal(assess(repl({ status })).verdict, 'manual-only', status);
  }
});

test('a replacement is never promised a refund to a card it never paid with', () => {
  const ctx = botContext(repl({ status: 'delivered' }));
  assert.match(ctx, /FREE REPLACEMENT/);
  assert.match(ctx, /Never tell them it goes back to "the payment method you originally paid with"/);
  assert.match(ctx, /record_wrong_cod_upi/);
  assert.match(ctx, /Do NOT call refund_wrong_cod/);
});

test('the copy knows whether a replacement customer has paid yet', () => {
  assert.match(botContext(repl({ status: 'delivered' })), /already paid the ₹199\.00 in cash/);
  assert.match(botContext(repl({ status: 'shipped' })),   /If they pay the ₹199\.00 at the door/);
});

test('a paid order is still refundable to source — replacements are the exception', () => {
  assert.equal(assess(at({ status: 'delivered', razorpay_payment_id: 'pay_x' })).verdict, 'refundable');
  assert.equal(assess(at({ status: 'delivered', razorpay_payment_id: 'OM2609' })).verdict, 'refundable');
});
