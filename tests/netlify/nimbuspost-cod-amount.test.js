'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { buildPayload } = require('../../netlify/functions/utils/nimbuspost-import');

// A full address so enrichAddress never needs a pincode lookup over the network.
const ADDRESS = 'Nachna, Jaisalmer, Jaisalmer, Rajasthan, India - 345028';

const order = (over = {}) => ({
  razorpay_order_id: 'IC-20260826-YD4LD',
  status: 'cod_pending',
  customer_name: 'Bhima Bhil',
  customer_phone: '8306174211',
  customer_address: ADDRESS,
  amount_paise: 35900,               // ₹299 book + ₹40 shipping + ₹20 COD fee
  cart_items: [{ title: "Can't Hurt Me (Hindi)", qty: 1, price: 299 }],
  ...over,
});

test('a COD order collects its own total, not the item subtotal', async () => {
  const p = await buildPayload(order());
  assert.strictEqual(p.payment_method, 'COD');
  assert.strictEqual(p.amount, 359, 'shipping and the COD fee must reach the courier');
});

// The IC-20260826-YD4LD regression: the order total never arrived and the item
// subtotal silently stood in for it, so ₹60 of fees were never collected.
for (const [label, amount_paise] of [
  ['missing', undefined], ['null', null], ['zero', 0], ['NaN', NaN], ['negative', -100],
]) {
  test(`a COD order with a ${label} amount is refused, never shipped at the subtotal`, async () => {
    await assert.rejects(
      () => buildPayload(order({ amount_paise })),
      err => {
        assert.match(err.message, /no usable amount to collect/);
        assert.match(err.message, /299/, 'the message should name the subtotal it refused to use');
        return true;
      },
    );
  });
}

test('a partial-COD order with no balance left to collect is refused, not pushed at ₹0', async () => {
  await assert.rejects(
    () => buildPayload(order({
      status: 'partial_cod_pending',
      advance_paid_paise: 5000,
      cart_items: [{ title: 'Ikigai', qty: 1, price: 299, _payment: { balance: 0 } }],
    })),
    /no usable amount to collect/,
  );
});

test('a partial-COD order collects the outstanding balance', async () => {
  const p = await buildPayload(order({
    status: 'partial_cod_pending',
    advance_paid_paise: 5000,
    cart_items: [{ title: 'Ikigai', qty: 1, price: 299, _payment: { balance: 309 } }],
  }));
  assert.strictEqual(p.payment_method, 'COD');
  assert.strictEqual(p.amount, 309);
});

// The guard must not touch shipments where nothing is collected at the door.
test('a free replacement still declares the books value and collects nothing', async () => {
  const p = await buildPayload(order({
    razorpay_order_id: 'IC-R-20260826-AAAAA',
    status: 'replacement_pending',
    source: 'replacement',
    amount_paise: 0,
    cart_items: [{ title: 'A Man Called Ove', qty: 1, price: 249, _replacement: {} }],
  }));
  assert.strictEqual(p.payment_method, 'prepaid');
  assert.strictEqual(p.amount, 249, 'declared parcel value, not a collectable');
});

test('a prepaid order with no recorded amount still pushes as prepaid', async () => {
  const p = await buildPayload(order({
    status: 'paid',
    razorpay_payment_id: 'pay_TRhwLt6KWuIDrZ',
    amount_paise: 0,
  }));
  assert.strictEqual(p.payment_method, 'prepaid');
  assert.strictEqual(p.amount, 299);
});
