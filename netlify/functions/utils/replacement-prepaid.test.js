/**
 * Replacements are never cash-on-delivery.
 *
 * A replacement's amount is the DECLARED VALUE on the label. It used to double
 * as a COD collectable, so a reshipment of a book the customer had already paid
 * for could have the courier collect its price a second time — while the
 * replacement email told them to "keep ₹X ready for the delivery agent".
 *
 * Every shipping path forces prepaid now. These tests exist so that a future
 * change to the COD heuristics cannot quietly restore collection: all three
 * builders share the same shape of `isCod` expression, and all three must agree.
 */

const test = require('node:test');
const assert = require('node:assert');
const { buildPayload } = require('./nimbuspost-import');
const { isReplacementOrder } = require('./replacement-order');

const REPLACEMENT = {
  razorpay_order_id: 'IC-R-20260807-P7DX5',
  source: 'replacement',
  status: 'replacement_pending',
  razorpay_payment_id: null,
  amount_paise: 0,
  customer_name: 'Test Customer',
  customer_phone: '9667336650',
  customer_address: '15 Test Street, Lucknow, Uttar Pradesh, 226001',
  cart_items: [{ title: 'A Book', qty: 1, price: 179, _replacement: { original_order_id: 'IC-20260801-ABCDE' } }],
};

test('a replacement is recognised by id, source and cart marker alike', () => {
  assert.strictEqual(isReplacementOrder(REPLACEMENT), true);
  assert.strictEqual(isReplacementOrder({ razorpay_order_id: 'IC-R-20260807-P7DX5' }), true);
  assert.strictEqual(isReplacementOrder({ source: 'replacement' }), true);
  assert.strictEqual(isReplacementOrder({ razorpay_order_id: 'IC-20260801-ABCDE' }), false);
});

test('a free replacement ships prepaid and still declares the books value', async () => {
  const p = await buildPayload(REPLACEMENT);
  assert.notStrictEqual(String(p.payment_method).toUpperCase(), 'COD');
  assert.strictEqual(p.amount, 179, 'declared on the label, not collected');
});

test('REGRESSION: a replacement with an amount is STILL prepaid', async () => {
  // ₹50 here is a declared parcel value. Before this was fixed it became a COD
  // collectable and the courier took ₹50 from a customer who owed nothing.
  const p = await buildPayload({ ...REPLACEMENT, amount_paise: 5000 });
  assert.notStrictEqual(String(p.payment_method).toUpperCase(), 'COD');
  assert.strictEqual(p.amount, 50);
});

test('a replacement is never treated as partial-COD either', async () => {
  const p = await buildPayload({ ...REPLACEMENT, status: 'partial_cod_pending', advance_paid_paise: 100 });
  assert.notStrictEqual(String(p.payment_method).toUpperCase(), 'COD');
});

test('a NORMAL unpaid order is still COD — the guard is replacement-only', async () => {
  const p = await buildPayload({
    ...REPLACEMENT,
    razorpay_order_id: 'IC-20260801-ABCDE',
    source: null,
    status: 'cod_pending',
    amount_paise: 55100,
    cart_items: [{ title: 'A Book', qty: 1, price: 551 }],
  });
  assert.strictEqual(String(p.payment_method).toUpperCase(), 'COD',
    'narrowing this to replacements must not make every order prepaid');
  assert.strictEqual(p.amount, 551);
});
