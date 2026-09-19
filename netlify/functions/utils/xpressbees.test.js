'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildOrder, chooseCourier } = require('../xpressbees-ship');

const base = (over = {}) => ({
  id: 'uuid-1', razorpay_order_id: 'IC-20260916-TEST',
  customer_name: 'Test Buyer', customer_phone: '+91 98765 43210',
  customer_address: 'Flat 12, Gokhale Rd, Dadar, Mumbai, Maharashtra - 400028',
  customer_email: 't@example.com', created_at: '2026-09-16T18:58:56.000Z',
  cart_items: [{ title: 'Atomic Habits', sku: 'AH1', qty: 1, price: 499 }],
  ...over,
});

const QUOTES = [
  { id: '3', name: 'Xpressbees Air',            total_charges: 108.7 },
  { id: '1', name: 'Xpressbees Surface 0.5 Kg', total_charges: 77.7  },
  { id: '4', name: 'Xpressbees 10 K.G',         total_charges: 210.0 },
];

// ── Courier choice ─────────────────────────────────────────────────────────

test('a preference wins over price', () => {
  assert.equal(chooseCourier(QUOTES, { priority: ['air'] }).id, '3');
});

test('with no preference match it takes the cheapest', () => {
  assert.equal(chooseCourier(QUOTES, { priority: ['nonexistent'] }).id, '1');
});

test('an explicit courier_id beats everything', () => {
  assert.equal(chooseCourier(QUOTES, { forceId: '4', priority: ['surface'] }).id, '4');
});

test('an unserviceable forced courier is refused, not silently swapped', () => {
  assert.throws(() => chooseCourier(QUOTES, { forceId: '99', priority: [] }), /not serviceable/i);
});

test('no quotes means no courier', () => {
  assert.equal(chooseCourier([], { priority: ['surface'] }), null);
});

// ── Payload ────────────────────────────────────────────────────────────────

test('a prepaid order must collect exactly zero', async () => {
  const { payload } = await buildOrder(base({ amount_paise: 49900, status: 'paid', razorpay_payment_id: 'pay_x' }));
  assert.equal(payload.payment_type, 'prepaid');
  assert.equal(payload.collectable_amount, 0, 'XpressBees requires zero on prepaid');
  assert.equal(payload.order_amount, 499);
});

test('a COD order collects no more than the order amount', async () => {
  const { payload } = await buildOrder(base({ amount_paise: 49900, status: 'cod_pending' }));
  assert.equal(payload.payment_type, 'cod');
  assert.ok(payload.collectable_amount <= payload.order_amount, 'their API rejects collectable > order_amount');
  assert.equal(payload.collectable_amount, 499);
});

test('partial COD declares the full order but collects only the balance', async () => {
  const { payload } = await buildOrder(base({
    amount_paise: 5200, status: 'partial_cod_pending',
    cart_items: [{ title: 'A', qty: 1, price: 517, _payment: { balance: 465, full_total: 517 } }],
  }));
  assert.equal(payload.order_amount, 517);
  assert.equal(payload.collectable_amount, 465);
  assert.ok(payload.collectable_amount < payload.order_amount);
});

test('a replacement never collects cash', async () => {
  const { payload } = await buildOrder(base({
    razorpay_order_id: 'IC-R-20260916-X', amount_paise: 0, status: 'replacement_pending',
    cart_items: [{ title: 'A', qty: 1, price: 517, _payment: { balance: 465, full_total: 517 } }],
  }));
  assert.equal(payload.payment_type, 'prepaid');
  assert.equal(payload.collectable_amount, 0);
  assert.equal(payload.order_amount, 517, 'still declared so a lost parcel is claimable');
});

test('order_number is capped at their 20-character limit', async () => {
  const { payload } = await buildOrder(base({
    razorpay_order_id: 'IC-R-CW-20260916-VERYLONGID', amount_paise: 49900, status: 'paid', razorpay_payment_id: 'p',
  }));
  assert.ok(payload.order_number.length <= 20, `got ${payload.order_number.length}`);
});

test('phone is reduced to 10 digits', async () => {
  const { payload } = await buildOrder(base({ amount_paise: 49900, status: 'paid', razorpay_payment_id: 'p' }));
  assert.match(payload.consignee.phone, /^\d{10}$/);
  assert.match(payload.pickup.phone, /^\d{10}$/);
});

test('city and state respect the 40-character limit', async () => {
  const { payload } = await buildOrder(base({ amount_paise: 49900, status: 'paid', razorpay_payment_id: 'p' }));
  assert.ok(payload.consignee.city.length <= 40);
  assert.ok(payload.consignee.state.length <= 40);
  assert.ok(payload.consignee.address.length <= 200);
});

test('every cart line reaches the label', async () => {
  const { payload, _meta } = await buildOrder(base({
    amount_paise: 65800, status: 'paid', razorpay_payment_id: 'p',
    cart_items: [
      { title: 'One', qty: 1, price: 150 },
      { title: 'Two', qty: 2, price: 254 },
    ],
  }));
  assert.equal(payload.order_items.length, 2);
  assert.equal(_meta.lines, 2);
  assert.equal(payload.order_items[1].qty, '2');
});

test('a bad pincode is refused before anything is booked', async () => {
  await assert.rejects(() => buildOrder(base({ amount_paise: 100, customer_address: 'nowhere in particular' })), /pincode/i);
});

test('a bad phone is refused before anything is booked', async () => {
  await assert.rejects(() => buildOrder(base({ amount_paise: 100, customer_phone: '123' })), /phone/i);
});

const xbc = require('./xpressbees');

test('every documented scan code maps to an order status', () => {
  for (const code of ['PP', 'IT', 'EX', 'FD', 'DL', 'RT', 'RT-IT', 'RT-DL']) {
    const m = xbc.mapStatusCode(code);
    assert.ok(m, `${code} is unmapped`);
    assert.ok(m.order_status, `${code} has no order status`);
  }
});

test('scan codes are matched case-insensitively and an unknown one is null', () => {
  assert.equal(xbc.mapStatusCode('dl').order_status, 'delivered');
  assert.equal(xbc.mapStatusCode('rt-it').order_status, 'rto');
  assert.equal(xbc.mapStatusCode('ZZ'), null);
  assert.equal(xbc.mapStatusCode(''), null);
});

test('RTO never maps to anything a refund could key off', () => {
  // A parcel coming back is not money going out. Keep these distinct.
  for (const code of ['RT', 'RT-IT', 'RT-DL']) {
    assert.ok(!/refund/i.test(xbc.mapStatusCode(code).order_status));
  }
  assert.notEqual(xbc.mapStatusCode('RT').order_status, xbc.mapStatusCode('DL').order_status);
});

test('order_number never exceeds 20 chars and unique_order_number is not sent', async () => {
  const { payload } = await buildOrder(base({ amount_paise: 49900, status: 'paid', razorpay_payment_id: 'p' }));
  assert.ok(!('unique_order_number' in payload), 'v1.1.5 does not document this field');
  assert.ok(payload.order_number.length <= 20);
});

test('NDR actions are capped at their 100-per-request limit', async () => {
  const many = Array.from({ length: 101 }, (_, i) => ({ awb: String(i), action: 're-attempt', action_data: {} }));
  await assert.rejects(() => xbc.ndrCreate(many), /at most 100/);
  await assert.rejects(() => xbc.ndrCreate([]), /at least one/);
});

// ── cancel_existing may only void a shipment that has not moved ────────────
// 66 orders were booked COD that should not have been. The 12 still awaiting
// pickup can be voided and re-booked prepaid. The other 54 cannot: cancelling
// an AWB that is already in a van does not recall the parcel, it just removes
// the number the customer traces it by. This allowlist is what keeps those
// two cases apart, and it is fed live status, never a stored one.
{
  const { CANCELLABLE } = require('../xpressbees-ship');

  test('only a shipment still awaiting pickup may be cancelled', () => {
    for (const ok of ['pending pickup', 'Pending Pickup', 'booked', 'BOOKED', 'manifested', 'awaiting pickup']) {
      assert.equal(CANCELLABLE.test(ok), true, `${ok} should be cancellable`);
    }
  });

  test('a moving or finished shipment is never cancelled', () => {
    for (const no of ['in transit', 'out for delivery', 'delivered', 'rto', 'rto in transit', 'exception', 'undelivered']) {
      assert.equal(CANCELLABLE.test(no), false, `${no} must NOT be cancellable`);
    }
  });

  test('an unknown or empty status is refused, not assumed safe', () => {
    for (const no of ['', '   ', 'something new xpressbees added', 'pending pickup extra']) {
      assert.equal(CANCELLABLE.test(no), false, `${JSON.stringify(no)} must be refused`);
    }
  });
}

// ── a re-book needs a new order number ─────────────────────────────────────
// XpressBees keeps an order number reserved after a cancel. Ten shipments
// were voided and then refused re-booking with "Order number already in use",
// which left ten parcels carrying no live AWB at all. The suffix is what makes
// the second booking possible; the 20-char cap is the API's, so the base has
// to give way to the suffix and not the other way round.
{
  const { buildOrder } = require('../xpressbees-ship');
  const ORDER = {
    id: 'uuid-1', razorpay_order_id: 'IC-R-CW-20260917-NQRA7',
    customer_name: 'Test Buyer', customer_phone: '9876543210',
    customer_address: 'Flat 12, Gokhale Rd, Dadar, Mumbai, Maharashtra - 400028',
    amount_paise: 14900, status: 'paid', razorpay_payment_id: 'pay_x',
    cart_items: [{ title: 'Atomic Habits', sku: 'AH1', qty: 1, price: 149 }],
  };

  test('a suffixed re-book still fits the 20-char order_number cap', async () => {
    const built = await buildOrder(ORDER, '-p');
    assert.ok(built.payload.order_number.length <= 20,
      `order_number was ${built.payload.order_number.length} chars: ${built.payload.order_number}`);
    assert.ok(built.payload.order_number.endsWith('-p'),
      'the suffix is the whole point; trimming it off re-creates the collision');
  });

  test('the real order id survives the suffix', async () => {
    const built = await buildOrder(ORDER, '-p');
    assert.equal(built._meta.order_id, 'IC-R-CW-20260917-NQRA7',
      'the suffix is cosmetic to the courier; everything we reconcile against uses the real id');
    assert.notEqual(built._meta.booked_as, built._meta.order_id);
  });

  test('no suffix leaves the order number exactly as it was', async () => {
    const built = await buildOrder(ORDER);
    assert.equal(built.payload.order_number, 'IC-R-CW-20260917-NQR');
  });
}
