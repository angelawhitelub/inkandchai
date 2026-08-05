const test = require('node:test');
const assert = require('node:assert/strict');
const {
  conversionOrderId,
  adjustmentTimeFor,
  istStamp,
  buildAdjustmentRows,
  toCsv,
} = require('./google-ads-adjustments');

const NOW = new Date('2026-08-06T12:00:00.000Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 3600 * 1000).toISOString();

const order = (extra) => ({
  razorpay_order_id: 'IC-20260701-AAAAA',
  razorpay_payment_id: null,
  status: 'cancelled',
  source: null,
  amount_paise: 25900,
  created_at: daysAgo(10),
  ...extra,
});

test('matches the id each checkout path actually sent as transaction_id', () => {
  // Razorpay fired with the payment id, everything else with the IC- order id.
  assert.equal(conversionOrderId(order({ razorpay_payment_id: 'pay_XYZ' })), 'pay_XYZ');
  assert.equal(conversionOrderId(order()), 'IC-20260701-AAAAA');
});

test('ignores the PhonePe transaction id backfilled by the payment sweep', () => {
  // The sweep writes PhonePe's id into razorpay_payment_id, but that order's
  // conversion fired with the IC- id, so only a real pay_ id may win.
  assert.equal(
    conversionOrderId(order({ razorpay_payment_id: 'T2508061234567890' })),
    'IC-20260701-AAAAA',
  );
});

test('retracts every state where the money was never realised', () => {
  const statuses = ['cancelled', 'cancelled_by_customer', 'rto', 'refunded', 'refund_pending', 'refund_failed'];
  const { rows } = buildAdjustmentRows(
    statuses.map((status, i) => order({ status, razorpay_order_id: `IC-${i}` })),
    { now: NOW },
  );
  assert.equal(rows.length, statuses.length);
});

test('leaves live and partially refunded orders alone', () => {
  const { rows, skipped } = buildAdjustmentRows([
    order({ status: 'delivered' }),
    order({ status: 'shipped' }),
    order({ status: 'partially_refunded' }),
  ], { now: NOW });
  assert.equal(rows.length, 0);
  assert.equal(skipped.status, 3);
});

test('drops replacements and the other storefront', () => {
  const { rows, skipped } = buildAdjustmentRows([
    order({ source: 'replacement' }),
    order({ source: 'paperbound' }),
  ], { now: NOW });
  assert.equal(rows.length, 0);
  assert.equal(skipped.source, 2);
});

test('drops order ids that never reached the checkout success screen', () => {
  const { rows, skipped } = buildAdjustmentRows([
    order({ razorpay_order_id: 'IC-W-20260701-AAAAA' }),   // WhatsApp bot order
    order({ razorpay_order_id: 'IC-R-20260701-BBBBB' }),   // replacement
    order({ razorpay_order_id: 'IC-CW-20260701-CCCCC' }),  // real Crossword checkout
  ], { now: NOW });
  assert.deepEqual(rows.map((r) => r.orderId), ['IC-CW-20260701-CCCCC']);
  assert.equal(skipped.never_converted, 2);
});

test('stays inside Google 55-day and 24-hour windows', () => {
  const { rows, skipped } = buildAdjustmentRows([
    order({ created_at: daysAgo(60), razorpay_order_id: 'IC-OLD' }),
    order({ created_at: new Date(NOW.getTime() - 2 * 3600 * 1000).toISOString(), razorpay_order_id: 'IC-NEW' }),
    order({ created_at: daysAgo(3), razorpay_order_id: 'IC-OK' }),
  ], { now: NOW });
  assert.deepEqual(rows.map((r) => r.orderId), ['IC-OK']);
  assert.equal(skipped.too_old, 1);
  assert.equal(skipped.too_recent, 1);
});

test('never emits the same order id twice', () => {
  const { rows, skipped } = buildAdjustmentRows([order(), order()], { now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(skipped.duplicate, 1);
});

test('uses the recorded loss time, falling back to now', () => {
  const cancelled = adjustmentTimeFor(order({ cancelled_at: daysAgo(4) }), NOW);
  assert.equal(cancelled.toISOString(), daysAgo(4));
  // 1,376 of 2,204 loss rows carry no timestamp at all; those adjust as of now.
  assert.equal(adjustmentTimeFor(order(), NOW).toISOString(), NOW.toISOString());
});

test('clamps an adjustment that predates its own conversion', () => {
  const t = adjustmentTimeFor(order({ created_at: daysAgo(5), cancelled_at: daysAgo(9) }), NOW);
  assert.equal(t.getTime(), new Date(daysAgo(5)).getTime() + 3600 * 1000);
  // ...and one stamped in the future never leaves the present.
  const future = adjustmentTimeFor(order({ cancelled_at: daysAgo(-3) }), NOW);
  assert.equal(future.getTime(), NOW.getTime());
});

test('writes bare IST timestamps, with the zone declared in the Parameters row', () => {
  // No offset suffix: Google rejects "+05:30" outright, and its own offset
  // form is RFC 822 ("+0530"). The Parameters row settles it instead.
  assert.equal(istStamp(new Date('2026-06-22T02:32:17.133Z')), '2026-06-22 08:02:17');
});

test('renders the upload format Google expects', () => {
  const { rows } = buildAdjustmentRows([order({ cancelled_at: daysAgo(4) })], { now: NOW });
  const csv = toCsv(rows, 'Purchase');
  assert.equal(csv,
    'Parameters:TimeZone=Asia/Calcutta\n'
    + 'Order ID,Conversion Name,Adjustment Time,Adjustment Type,Adjusted Value,Adjusted Value Currency\n'
    + 'IC-20260701-AAAAA,Purchase,2026-08-02 17:30:00,RETRACT,,\n');
});

test('says RETRACT, not the API enum RETRACTION', () => {
  // The upload file format and the Google Ads API disagree on this word, and
  // sending the API's spelling failed all 2,145 rows.
  const { rows } = buildAdjustmentRows([order()], { now: NOW });
  const csv = toCsv(rows, 'Purchase');
  assert.match(csv, /,RETRACT,/);
  assert.doesNotMatch(csv, /RETRACTION/);
});

test('keeps all six template columns, empty value columns included', () => {
  const { rows } = buildAdjustmentRows([order()], { now: NOW });
  const [, header, first] = toCsv(rows, 'Purchase').trim().split('\n');
  assert.equal(header.split(',').length, 6);
  assert.equal(first.split(',').length, 6);
});

test('quotes a conversion name containing a comma', () => {
  const { rows } = buildAdjustmentRows([order()], { now: NOW });
  assert.match(toCsv(rows, 'Purchase, web'), /,"Purchase, web",/);
});
