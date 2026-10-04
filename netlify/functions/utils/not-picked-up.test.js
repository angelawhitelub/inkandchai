const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, summarize, withOriginal } = require('./not-picked-up');

const NOW = Date.parse('2026-10-03T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const order = (over = {}) => ({
  id: 'u1', razorpay_order_id: 'IC-20260930-AAAAA', status: 'shipped', created_at: hoursAgo(72),
  customer_name: 'Riya', customer_address: '12 MG Road, Pune 411001', amount_paise: 49900,
  razorpay_payment_id: 'pay_1', tracking_id: '143449610544011', courier_name: 'Xpressbees',
  awb_assigned_at: hoursAgo(60), shipment_moved_at: null, last_courier_status: 'pending pickup',
  ...over,
});

test('a booked parcel the courier says is still waiting is listed, confirmed', () => {
  const r = classify(order(), NOW);
  assert.equal(r.bucket, 'awaiting_pickup');
  assert.equal(r.confirmed, true);
  assert.equal(r.age_hours, 72);
  assert.equal(r.hours_since_booking, 60);
  assert.equal(r.pincode, '411001');
  assert.equal(r.payment, 'prepaid');
});

test('younger than 48 hours is not listed', () => {
  assert.equal(classify(order({ created_at: hoursAgo(47) }), NOW), null);
  assert.ok(classify(order({ created_at: hoursAgo(49) }), NOW));
  assert.equal(classify(order({ created_at: hoursAgo(60) }), NOW, 72), null, 'the threshold is adjustable');
});

test('anything that has moved is not listed', () => {
  assert.equal(classify(order({ shipment_moved_at: hoursAgo(10) }), NOW), null);
  assert.equal(classify(order({ last_courier_status: 'in transit' }), NOW), null);
  assert.equal(classify(order({ last_courier_status: null, last_nimbuspost_status: 'picked' }), NOW), null);
  for (const status of ['in_transit', 'out_for_delivery', 'delivered', 'rto', 'cancelled', 'refunded']) {
    assert.equal(classify(order({ status }), NOW), null, status);
  }
});

test('a booking with no scan at all is listed but not claimed as confirmed', () => {
  const r = classify(order({ courier_name: 'Delhivery', last_courier_status: null }), NOW);
  assert.equal(r.bucket, 'awaiting_pickup');
  assert.equal(r.confirmed, false);
});

test('an unbooked paid or COD order is listed as not booked', () => {
  const r = classify(order({ status: 'cod_pending', tracking_id: null, razorpay_payment_id: null, nimbus_pushed_at: hoursAgo(50) }), NOW);
  assert.equal(r.bucket, 'not_booked');
  assert.equal(r.payment, 'cod');
  assert.ok(r.nimbus_pushed_at);
  // Payment never captured / awaiting confirmation: not shippable, not listed.
  assert.equal(classify(order({ status: 'pending', tracking_id: null }), NOW), null);
  assert.equal(classify(order({ status: 'cod_awaiting_confirmation', tracking_id: null }), NOW), null);
});

test('a free replacement is labelled as one', () => {
  assert.equal(classify(order({ razorpay_order_id: 'IC-R-20260918-7LWJX', razorpay_payment_id: null }), NOW).payment, 'replacement');
});

test('a replacement row learns how its original was paid, and the UPI given in the report', () => {
  const repl = order({
    razorpay_order_id: 'IC-R-20260918-7LWJX', razorpay_payment_id: null, amount_paise: 0, source: 'replacement',
    cart_items: [{ title: 'The Shiva Sutras', qty: 1, price: 299, _replacement: { original_order_id: 'IC-20260913-CW4QJ', reason: 'missing_item' } }],
  });
  const row = classify(repl, NOW);
  assert.equal(row.payment, 'replacement');

  const cod = withOriginal(row, { razorpay_order_id: 'IC-20260913-CW4QJ', razorpay_payment_id: null, status: 'delivered',
    cart_items: [{ title: 'The Shiva Sutras', _missing: true, _refund_upi_id: '9876543210@ybl' }] });
  assert.equal(cod.replacement.original_payment, 'cod');
  assert.equal(cod.replacement.refund_upi_id, '9876543210@ybl');
  assert.equal(cod.replacement.refund_upi_source, 'missing_report');

  const prepaid = withOriginal(row, { razorpay_payment_id: 'pay_9', status: 'delivered', cart_items: [] });
  assert.equal(prepaid.replacement.original_payment, 'prepaid');
  assert.equal(prepaid.replacement.refund_upi_id, '');

  const partial = withOriginal(row, { razorpay_payment_id: 'pay_9', status: 'delivered', cart_items: [{ _payment: { mode: 'partial_cod' } }] });
  assert.equal(partial.replacement.original_payment, 'partial_cod');

  assert.equal(withOriginal(row, null).replacement.original_payment, 'unknown');
  const plain = classify(order(), NOW);
  assert.equal(withOriginal(plain, null), plain, 'a non-replacement row is untouched');
});

test('a replacement of a replacement is paid however the first order was', () => {
  const row = classify(order({ razorpay_payment_id: null, source: 'replacement',
    cart_items: [{ title: 'X', _replacement: { original_order_id: 'IC-R-2' } }] }), NOW);
  const direct = { razorpay_order_id: 'IC-R-2', razorpay_payment_id: null, source: 'replacement',
    cart_items: [{ title: 'X', _replacement: { original_order_id: 'IC-1' } }] };
  const root = { razorpay_order_id: 'IC-1', razorpay_payment_id: 'pay_1', cart_items: [] };
  const r = withOriginal(row, { direct, root, via: ['IC-R-2'] });
  assert.equal(r.replacement.original_payment, 'prepaid');
  assert.equal(r.replacement.paid_order_id, 'IC-1');
  assert.equal(withOriginal(row, { direct, root: null, via: ['IC-R-2'] }).replacement.original_payment, 'unknown');
});

test('a UPI ID already on the replacement wins over the report', () => {
  const row = classify(order({ razorpay_payment_id: null, source: 'replacement',
    cart_items: [{ title: 'X', _replacement: { original_order_id: 'IC-1', refund_upi_id: 'new@upi' } }] }), NOW);
  const r = withOriginal(row, { razorpay_payment_id: null, cart_items: [{ _refund_upi_id: 'old@upi' }] });
  assert.equal(r.replacement.refund_upi_id, 'new@upi');
  assert.equal(r.replacement.refund_upi_source, 'replacement');
});

test('summary counts buckets and couriers', () => {
  const rows = [
    classify(order(), NOW),
    classify(order({ id: 'u2', courier_name: 'Delhivery', last_courier_status: null }), NOW),
    classify(order({ id: 'u3', status: 'paid', tracking_id: '' }), NOW),
  ];
  const c = summarize(rows);
  assert.deepEqual([c.total, c.awaiting_pickup, c.awaiting_confirmed, c.not_booked], [3, 2, 1, 1]);
  assert.deepEqual(c.by_courier, { Xpressbees: 1, Delhivery: 1 });
});
