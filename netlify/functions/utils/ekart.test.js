const test = require('node:test');
const assert = require('node:assert');

const ek = require('./ekart');

/**
 * The money mapping is the one thing here that can take real cash off a real
 * customer at a doorstep, so it is tested against the storage shape rather
 * than against a mock: a partial-COD row keeps the DEPOSIT in amount_paise and
 * the BALANCE in cart_items[0]._payment. Reading the wrong one bills the whole
 * order again.
 */
const addr = 'Sagolband Ramji Kabui Khul, Imphal West, Manipur, 795001';

const baseOrder = {
  id: 'uuid-1',
  razorpay_order_id: 'IC-20260922-TEST1',
  customer_name: 'Test Buyer',
  customer_phone: '7085189518',
  customer_address: addr,
  created_at: '2026-09-22T10:00:00Z',
};

test('a plain COD order collects the full order value', () => {
  const s = ek.buildShipment({ ...baseOrder, status: 'cod_pending', amount_paise: 63100 });
  assert.equal(s.payment_mode, 'COD');
  assert.equal(s.cod_amount, 631);
  assert.equal(s.total_amount, 631);
});

test('a prepaid order collects nothing', () => {
  const s = ek.buildShipment({ ...baseOrder, status: 'paid', amount_paise: 63100 });
  assert.equal(s.payment_mode, 'Prepaid');
  assert.equal(s.cod_amount, 0);
  assert.equal(s.total_amount, 631);
});

test('a partial-COD order collects only the balance, not the whole order', () => {
  const s = ek.buildShipment({
    ...baseOrder,
    status: 'partial_cod_pending',
    amount_paise: 10000,            // the DEPOSIT already paid
    advance_paid_paise: 0,
    cart_items: [{ _payment: { mode: 'partial_cod', rate: 0, balance: 494, deposit: 100, full_total: 594 } }],
  });
  assert.equal(s.payment_mode, 'COD');
  assert.equal(s.cod_amount, 494, 'must bill the balance, never the full total');
  assert.notEqual(s.cod_amount, 594);
});

test('the parcel is flat 500g / 15x10x5 whatever the order holds', () => {
  const s = ek.buildShipment({
    ...baseOrder, status: 'cod_pending', amount_paise: 63100,
    cart_items: [{ title: 'A', quantity: 7 }, { title: 'B', quantity: 3 }],
  });
  assert.equal(s.weight, 500);
  assert.equal(s.length, 15);
  assert.equal(s.width, 10);
  assert.equal(s.height, 5);
});

test('an unusable pincode or phone throws instead of booking a lost parcel', () => {
  assert.throws(
    () => ek.buildShipment({ ...baseOrder, status: 'cod_pending', amount_paise: 63100, customer_address: 'no pincode here' }),
    /pincode/i,
  );
  assert.throws(
    () => ek.buildShipment({ ...baseOrder, status: 'cod_pending', amount_paise: 63100, customer_phone: '123' }),
    /phone/i,
  );
});

test('the suffix is applied to the reference Ekart sees, not to our id', () => {
  const s = ek.buildShipment({ ...baseOrder, status: 'cod_pending', amount_paise: 63100 }, '-e2');
  assert.equal(s.order_number, 'IC-20260922-TEST1-e2');
});

test('a direct booking does not get the legacy NimbusPost tracking page', () => {
  const url = ek.trackingUrl('ABC123');
  assert.ok(!/nimbus/i.test(url), url);
  assert.ok(url.includes('ABC123'));
});
