const test = require('node:test');
const assert = require('node:assert/strict');
const { buildClone, cloneIdFor, cloneRoot } = require('../admin-clone-order')._test;
const { isReplacementOrder } = require('./replacement-order');
const { classifyShipmentMoney } = require('./shipment-money');
const { baseOrderNumber } = require('./booking-guard');

const original = {
  razorpay_order_id: 'IC-20261029-0NPDA', status: 'out_for_delivery', tracking_id: '143449611422641', courier_name: 'XpressBees',
  customer_name: 'Asha', customer_phone: '9876543210', customer_address: '12 MG Road, Pune, Maharashtra 411001',
  amount_paise: 25900, cart_items: [{ title: 'A', qty: 2, price: 199, _payment: { balance: 0 } }, { title: 'B', qty: 1, price: 99 }],
};

test('clone ids stay within 20 characters and are never read as the original by the panels', () => {
  assert.equal(cloneIdFor('IC-20261029-0NPDA', 2), 'IC-20261029-0NPDA-N2');
  assert.equal(cloneIdFor('IC-CW-20261030-WN8UA', 3), 'IC-20261030-WN8UA-N3');
  for (const id of ['IC-20261029-0NPDA-N2', 'IC-20261030-WN8UA-N3']) {
    assert.ok(id.length <= 20);
    assert.equal(baseOrderNumber(id), id, 'the double-booking guard sees the clone as its own order');
  }
});

test('a free clone copies the books, collects nothing and is not a sale', () => {
  const { row, warnings } = buildClone(original, { customer_phone: '9123456789' });
  assert.equal(row.amount_paise, 0);
  assert.equal(row.status, 'confirmed');
  assert.equal(row.source, 'clone');
  assert.deepEqual(row.cart_items.map((l) => [l.title, l.qty]), [['A', 2], ['B', 1]]);
  assert.equal(row.cart_items[0]._payment, undefined, 'order money never travels with the books');
  assert.equal(row.cart_items[0]._clone.of, 'IC-20261029-0NPDA');
  assert.equal(row.customer_phone, '9123456789');
  assert.ok(isReplacementOrder(row));
  const money = classifyShipmentMoney(row, isReplacementOrder(row));
  assert.equal(money.isCOD, false);
  assert.equal(money.collectableAmount, 0);
  assert.ok(money.orderValueRs > 0, 'declared value is the books');
  assert.match(warnings.join(), /still "out_for_delivery".*143449611422641/);
});

test('a COD clone collects exactly what the owner typed', () => {
  const { row } = buildClone(original, { payment: 'cod', cod_rs: 259, items: [{ index: 1, qty: 1 }] });
  assert.equal(row.status, 'cod_pending');
  assert.equal(isReplacementOrder(row), false);
  const money = classifyShipmentMoney(row, isReplacementOrder(row));
  assert.equal(money.isCOD, true);
  assert.equal(money.collectableAmount, 259);
  assert.deepEqual(row.cart_items.map((l) => l.title), ['B']);
});

test('bad input is refused with a reason', () => {
  assert.throws(() => buildClone(original, { payment: 'cod', cod_rs: 0 }), /amount/);
  assert.throws(() => buildClone(original, { customer_phone: '12345' }), /mobile/);
  assert.throws(() => buildClone(original, { customer_address: 'no pin here' }), /pincode/);
  assert.throws(() => buildClone(original, { items: [{ index: 9, qty: 1 }] }), /not in this order/);
});

test('a clone of a clone points back to the first order', () => {
  const { row } = buildClone(original, {});
  assert.equal(cloneRoot({ razorpay_order_id: 'IC-20261029-0NPDA-N2', cart_items: row.cart_items }), 'IC-20261029-0NPDA');
});
