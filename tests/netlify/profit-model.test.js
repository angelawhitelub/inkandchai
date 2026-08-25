const test = require('node:test');
const assert = require('node:assert');
const {
  classify, unitsOf, revenueOf, costsOf, computeProfit, DEFAULT_RATES,
} = require('../../netlify/functions/utils/profit-model');

const RATES = DEFAULT_RATES;          // 92 ads / 62 shipping / 80 book
const book = (qty = 1) => ({ qty, price: 299, title: 'X' });
const order = (o) => ({ amount_paise: 29900, cart_items: [book()], ...o });

test('classify: cancelled wins over everything', () => {
  assert.equal(classify(order({ status: 'cancelled', tracking_id: 'AWB1', last_nimbuspost_status: 'delivered' })), 'cancelled');
});

test('classify: courier says RTO even when the status column has not caught up', () => {
  assert.equal(classify(order({ status: 'shipped', last_nimbuspost_status: 'rto in transit' })), 'rto');
  assert.equal(classify(order({ status: 'rto' })), 'rto');
});

test('classify: partial COD stays pending in the status column but is delivered per courier', () => {
  assert.equal(classify(order({ status: 'partial_cod_pending', last_nimbuspost_status: 'delivered' })), 'delivered');
});

test('classify: an AWB alone means it is in transit', () => {
  assert.equal(classify(order({ status: 'cod_pending', tracking_id: 'AWB9' })), 'in_transit');
});

test('classify: no AWB, no courier record → nothing has been shipped', () => {
  assert.equal(classify(order({ status: 'cod_pending' })), 'pending');
  assert.equal(classify(order({ status: 'pending_phonepe' })), 'pending');
});

test('classify: every refund flavour buckets as refunded', () => {
  for (const s of ['refunded', 'refund_pending', 'refund_failed']) {
    assert.equal(classify(order({ status: s })), 'refunded');
  }
});

test('RTO costs shipping twice and consumes no stock', () => {
  const o = order({ status: 'rto', cart_items: [book(2)] });
  const c = costsOf(o, 'rto', RATES);
  assert.equal(c.shipping, 124);
  assert.equal(c.cogs, 0, 'the books came back — their cost is not lost');
  assert.equal(revenueOf(o, 'rto'), 0);
});

test('cancelled costs no shipping — NimbusPost reverses it to the wallet', () => {
  const o = order({ status: 'cancelled' });
  const c = costsOf(o, 'cancelled', RATES);
  assert.equal(c.shipping, 0);
  assert.equal(c.cogs, 0);
  assert.equal(revenueOf(o, 'cancelled'), 0);
  assert.equal(c.ads, 92, 'the ad click was still paid for');
});

test('refund before despatch is free to ship; after despatch it is a round trip', () => {
  assert.equal(costsOf(order({ status: 'refunded' }), 'refunded', RATES).shipping, 0);
  assert.equal(costsOf(order({ status: 'refunded', tracking_id: 'A' }), 'refunded', RATES).shipping, 124);
});

test('delivered: one-way shipping and stock consumed per unit', () => {
  const c = costsOf(order({ cart_items: [book(2), book(1)] }), 'delivered', RATES);
  assert.equal(c.units, 3);
  assert.equal(c.shipping, 62);
  assert.equal(c.cogs, 240);
});

test('partial COD revenue includes the balance collected at the door', () => {
  const o = {
    status: 'partial_cod_pending',
    amount_paise: 4400,
    cart_items: [{ qty: 1, _payment: { mode: 'partial_cod', balance: 394, deposit: 44, full_total: 438 } }],
    last_nimbuspost_status: 'delivered',
  };
  assert.equal(revenueOf(o, classify(o)), 438, 'not the ₹44 advance');
});

test('an order with no line items still counts as one book', () => {
  assert.equal(unitsOf({ cart_items: [] }), 1);
  assert.equal(unitsOf({}), 1);
});

test('computeProfit: end-to-end on a mixed book of orders', () => {
  const orders = [
    { status: 'delivered', amount_paise: 39900, cart_items: [book()] },
    { status: 'delivered', amount_paise: 39900, cart_items: [book()] },
    { status: 'rto',       amount_paise: 39900, cart_items: [book()] },
    { status: 'cancelled', amount_paise: 39900, cart_items: [book()] },
  ];
  const r = computeProfit(orders);

  // delivered: 798 revenue − 184 ads − 124 shipping − 160 books = 330
  assert.equal(r.buckets.delivered.revenue, 798);
  assert.equal(r.buckets.delivered.net, 330);
  // rto: 0 − 92 − 124 − 0
  assert.equal(r.buckets.rto.net, -216);
  // cancelled: the ad spend only
  assert.equal(r.buckets.cancelled.net, -92);

  assert.equal(r.totals.revenue, 798);
  assert.equal(r.totals.net, 330 - 216 - 92);
  assert.equal(r.totals.orders, 4);

  assert.equal(r.kpis.rto_rate_pct, 33.33, '1 of 3 despatched parcels came back');
  assert.equal(r.kpis.cancel_rate_pct, 25);
  assert.equal(r.kpis.profit_per_delivered_order, 165);
});

test('computeProfit: rate overrides flow through', () => {
  const r = computeProfit([{ status: 'delivered', amount_paise: 50000, cart_items: [book()] }],
    { adCostPerOrder: 0, shippingPerOrder: 0, bookCost: 0 });
  assert.equal(r.totals.net, 500);
  assert.equal(r.rates.bookCost, 0);
});

test('computeProfit: empty input does not divide by zero', () => {
  const r = computeProfit([]);
  assert.equal(r.totals.net, 0);
  assert.equal(r.kpis.rto_rate_pct, 0);
  assert.equal(r.kpis.margin_pct, 0);
});
