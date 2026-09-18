'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classifyShipmentMoney } = require('./shipment-money');
const { buildShipment, ithinkDateTime } = require('../ithink-order-push');

const ADDR = 'Flat 12, Gokhale Rd, Dadar, Mumbai, Maharashtra - 400028';
const base = (over = {}) => ({
  id: 'uuid-1', razorpay_order_id: 'IC-20260916-TEST',
  customer_name: 'Test Buyer', customer_phone: '9876543210',
  customer_address: ADDR, customer_email: 't@example.com',
  created_at: '2026-09-16T18:58:56.000Z',
  cart_items: [{ title: 'Atomic Habits', sku: 'AH1', qty: 1, price: 499 }],
  ...over,
});

// ── The money rules ────────────────────────────────────────────────────────

test('fully prepaid order collects nothing', () => {
  const m = classifyShipmentMoney(base({ amount_paise: 49900, status: 'paid', razorpay_payment_id: 'pay_x' }), false);
  assert.equal(m.isCOD, false);
  assert.equal(m.collectableAmount, 0);
  assert.equal(m.orderValueRs, 499);
  assert.equal(m.shipmentPaymentType, 'prepaid');
});

test('pure COD collects the full amount', () => {
  const m = classifyShipmentMoney(base({ amount_paise: 49900, status: 'cod_pending' }), false);
  assert.equal(m.isCOD, true);
  assert.equal(m.collectableAmount, 499);
  assert.equal(m.shipmentPaymentType, 'cod');
});

test('partial COD collects only the balance, not the deposit', () => {
  const order = base({
    amount_paise: 5200, status: 'partial_cod_pending',
    cart_items: [{ title: 'A', qty: 1, price: 517, _payment: { balance: 465, full_total: 517 } }],
  });
  const m = classifyShipmentMoney(order, false);
  assert.equal(m.isPartialCod, true);
  assert.equal(m.orderValueRs, 517, 'declares the whole order');
  assert.equal(m.collectableAmount, 465, 'collects only the balance');
  assert.equal(m.advanceRs, 52, 'the deposit is the advance');
  assert.equal(m.shipmentPaymentType, 'partial_cod');
});

test('a partial-COD deposit is not mistaken for full prepayment', () => {
  // razorpay_payment_id is set -- a prepaid-first test would collect nothing.
  const order = base({
    amount_paise: 5200, status: 'partial_cod_pending', razorpay_payment_id: 'pay_deposit',
    cart_items: [{ title: 'A', qty: 1, price: 517, _payment: { balance: 465, full_total: 517 } }],
  });
  const m = classifyShipmentMoney(order, false);
  assert.equal(m.collectableAmount, 465);
  assert.equal(m.fullyPrepaid, false);
});

test('an unpaid order wearing a non-COD status is still COD', () => {
  // The admin Update-status dropdown sets 'confirmed'. A status whitelist let
  // these ship prepaid and collect nothing -- 36 real orders.
  const m = classifyShipmentMoney(base({ amount_paise: 49900, status: 'confirmed' }), false);
  assert.equal(m.isCOD, true);
  assert.equal(m.collectableAmount, 499);
});

test('a replacement never collects cash, even carrying a COD balance', () => {
  const order = base({
    razorpay_order_id: 'IC-R-20260916-TEST', amount_paise: 0, status: 'replacement_pending',
    cart_items: [{ title: 'A', qty: 1, price: 517, _payment: { balance: 465, full_total: 517 } }],
  });
  const m = classifyShipmentMoney(order, true);
  assert.equal(m.isCOD, false);
  assert.equal(m.collectableAmount, 0);
  assert.equal(m.isPartialCod, false);
});

test('a free replacement still declares what the books are worth', () => {
  const order = base({
    razorpay_order_id: 'IC-R-1', amount_paise: 0, status: 'replacement_pending',
    cart_items: [{ title: 'A', qty: 2, price: 300 }],
  });
  const m = classifyShipmentMoney(order, true);
  assert.equal(m.orderValueRs, 600, 'a zero-value parcel is uninsurable');
  assert.equal(m.collectableAmount, 0);
});

test('partial COD with no balance metadata fails closed', () => {
  const order = base({ amount_paise: 5200, status: 'partial_cod_pending', cart_items: [{ title: 'A', qty: 1, price: 517 }] });
  assert.throws(() => classifyShipmentMoney(order, false), /missing its balance metadata/);
});

test('cart_items arriving as a JSON string still parses', () => {
  const order = base({
    amount_paise: 5200, status: 'partial_cod_pending',
    cart_items: JSON.stringify([{ title: 'A', qty: 1, price: 517, _payment: { balance: 465, full_total: 517 } }]),
  });
  const m = classifyShipmentMoney(order, false);
  assert.equal(m.collectableAmount, 465);
});

// ── The iThink payload ─────────────────────────────────────────────────────

test('iThink wants dd-mm-yyyy HH:MM:SS', () => {
  assert.match(ithinkDateTime('2026-09-16T18:58:56.000Z'), /^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/);
});

test('a multi-item order is ONE shipment whose products sum to the declared value', async () => {
  const order = base({
    amount_paise: 65800, status: 'paid', razorpay_payment_id: 'pay_x',
    cart_items: [
      { title: 'The Power of Your Subconscious Mind', qty: 1, price: 150 },
      { title: 'Ikigai', qty: 1, price: 99 },
      { title: '21 Lessons', qty: 2, price: 200 },
    ],
  });
  const { shipment, _meta } = await buildShipment(order);
  assert.equal(_meta.lines, 3);
  const sum = shipment.products.reduce((t, p) => t + Number(p.product_price) * Number(p.product_quantity), 0);
  assert.equal(Math.round(sum * 100) / 100, 658, 'lines must reconcile to the declared value exactly');
  assert.equal(shipment.total_amount, '658');
});

test('COD payload carries the collectable in cod_amount, not as a discount', async () => {
  const order = base({
    amount_paise: 5200, status: 'partial_cod_pending',
    cart_items: [{ title: 'A', qty: 1, price: 517, _payment: { balance: 465, full_total: 517 } }],
  });
  const { shipment } = await buildShipment(order);
  assert.equal(shipment.payment_mode, 'COD');
  assert.equal(shipment.cod_amount, '465');
  assert.equal(shipment.advance_amount, '52');
  assert.equal(shipment.total_discount, '0', 'the discount field must stay clean');
});

test('an unparseable pincode is refused rather than shipped blind', async () => {
  await assert.rejects(() => buildShipment(base({ amount_paise: 100, customer_address: 'somewhere vague' })), /pincode/i);
});

test('an empty cart still declares the order value', async () => {
  const { shipment } = await buildShipment(base({ amount_paise: 49900, status: 'paid', razorpay_payment_id: 'p', cart_items: [] }));
  assert.equal(shipment.products.length, 1);
  assert.equal(shipment.products[0].product_price, '499');
});

test('a cart with no qty-1 line reports any residue instead of hiding it', () => {
  // Every line qty 2, so no line can absorb an odd paise remainder exactly.
  const order = base({
    amount_paise: 65700, status: 'paid', razorpay_payment_id: 'p',
    cart_items: [{ title: 'A', qty: 2, price: 150 }, { title: 'B', qty: 2, price: 99 }],
  });
  return buildShipment(order).then(({ shipment, _meta }) => {
    const sum = shipment.products.reduce((t, p) => t + Number(p.product_price) * Number(p.product_quantity), 0);
    assert.ok(Math.abs(sum - 657) <= 0.02, `sum ${sum} should be within 2 paise of 657`);
    assert.equal(Math.abs(_meta.residual_paise) <= 2, true, 'residue must be reported');
  });
});

test('every shipment carries alt_phone, which iThink requires despite the docs', async () => {
  const { shipment } = await buildShipment(base({ amount_paise: 49900, status: 'paid', razorpay_payment_id: 'p' }));
  assert.equal(shipment.alt_phone, shipment.phone, 'an absent alt_phone fails the whole batch');
  assert.equal(shipment.billing_alt_phone, shipment.phone);
  // Presence of the fields iThink validates, even when empty.
  for (const f of ['company_name', 'add3', 'billing_company_name', 'billing_add2', 'billing_add3', 'billing_country']) {
    assert.ok(f in shipment, `${f} must be present in the payload`);
  }
});

test('products carry a tax rate, without which iThink crashes on a null float', async () => {
  const { shipment } = await buildShipment(base({ amount_paise: 49900, status: 'paid', razorpay_payment_id: 'p' }));
  for (const p of shipment.products) {
    assert.equal(p.product_tax_rate, '0');
    // Must not be empty: iThink coerces '' to null and crashes casting it.
    assert.ok(p.product_hsn_code && p.product_hsn_code.length > 0, 'hsn must be non-empty');
    assert.equal(p.product_hsn_code, '4901');
  }
});

test('a short address is rebuilt from city and state to clear the 10-char minimum', async () => {
  const { shipment } = await buildShipment(base({
    amount_paise: 49900, status: 'paid', razorpay_payment_id: 'p',
    customer_address: 'A-1, Kochi, Kerala - 682001',
  }));
  assert.ok(shipment.add.length >= 10, `add was "${shipment.add}"`);
});

test('a shipment is never sent with an address iThink would refuse', async () => {
  // The invariant that matters: either the address clears 10 characters or the
  // order is reported. Never a third outcome. Enrichment fills city and state
  // from the pincode, so a terse address usually clears it on its own.
  for (const addr of ['X, 110006', 'A-1, Kochi, Kerala - 682001', 'no pincode here']) {
    let out = null, threw = null;
    try { out = await buildShipment(base({ amount_paise: 49900, customer_address: addr })); }
    catch (e) { threw = e; }
    if (out) assert.ok(out.shipment.add.length >= 10, `"${addr}" produced "${out.shipment.add}"`);
    else assert.ok(threw, `"${addr}" neither built nor reported`);
  }
});

// ── The order-number suffix ────────────────────────────────────────────────
//
// The panel still holds records for orders that have since gone out on another
// courier, so a fresh push is indistinguishable from the stale ones. A suffix
// marks the new batch on sight — and because the number differs, it lands as a
// new record instead of bouncing off iThink's duplicate check.

test('the suffix changes the number sent to iThink and nothing else', async () => {
  const { shipment, _meta } = await buildShipment(base({ amount_paise: 49900 }), '-c');
  assert.equal(shipment.order, 'IC-20260916-TEST-c', 'iThink must receive the suffixed number');
  // Everything we stamp, skip on and report must stay keyed on the real order,
  // or the push would mark the wrong row and the report would name an order
  // that does not exist.
  assert.equal(_meta.order_id, 'IC-20260916-TEST');
  assert.equal(_meta.db_id, 'uuid-1');
  assert.equal(_meta.pushed_as, 'IC-20260916-TEST-c');
});

test('no suffix leaves the number exactly as it was', async () => {
  const { shipment, _meta } = await buildShipment(base({ amount_paise: 49900 }));
  assert.equal(shipment.order, 'IC-20260916-TEST');
  assert.equal(_meta.pushed_as, 'IC-20260916-TEST');
});

test('the suffix is appended, never substituted into, the order number', async () => {
  // A replacement id already carries hyphenated segments; the suffix must not
  // disturb them or the AWB report cannot be matched back by stripping it.
  const { shipment } = await buildShipment(
    base({ razorpay_order_id: 'IC-R-CW-20260917-NQRA7', amount_paise: 49900 }), '-c');
  assert.equal(shipment.order, 'IC-R-CW-20260917-NQRA7-c');
  assert.equal(shipment.order.replace(/-c$/, ''), 'IC-R-CW-20260917-NQRA7');
});
