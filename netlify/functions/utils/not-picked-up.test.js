const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, summarize } = require('./not-picked-up');

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
