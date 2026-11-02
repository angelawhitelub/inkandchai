'use strict';

// A stray NimbusPost booking (a second AWB, or a cancelled order booked
// again) is cancelled; the order's own live shipment never is.

const test = require('node:test');
const assert = require('node:assert/strict');
const { cancelStray } = require('../../netlify/functions/nimbuspost-cancel-stray-awb')._test;

function db(order) {
  const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: order, error: null }) };
  return { from: () => q };
}
const tracked = (awb, order_number, status) => async () => [{ awb_number: awb, order_number, status }];

async function run(order, row, { dryRun = false } = {}) {
  const cancelled = [];
  const out = await cancelStray({ orderId: order ? order.razorpay_order_id : 'IC-X', awb: '2364', dryRun }, {
    supabase: db(order),
    track: row ? tracked(...row) : async () => [],
    cancel: async (awb) => { cancelled.push(awb); return { ok: true }; },
  });
  return { ...out, cancelled };
}

const shippingElsewhere = { razorpay_order_id: 'IC-1', status: 'shipped', courier_name: 'Xpressbees', tracking_id: '1434' };

test('a second booking of an order shipping on another AWB is cancelled', async () => {
  const r = await run(shippingElsewhere, ['2364', 'IC-1', 'Pickup Pending']);
  assert.equal(r.status, 200);
  assert.equal(r.body.action, 'cancelled');
  assert.equal(r.body.reason, 'order_ships_on_another_awb');
  assert.deepEqual(r.cancelled, ['2364']);
});

test('a cancelled order booked again is cancelled, even with a -C suffix', async () => {
  const r = await run({ razorpay_order_id: 'IC-2', status: 'cancelled', tracking_id: '9999' }, ['2364', 'IC-2-C1', 'booked']);
  assert.equal(r.body.action, 'cancelled');
  assert.equal(r.body.reason, 'order_cancelled_here');
});

test('dry run reports without cancelling', async () => {
  const r = await run(shippingElsewhere, ['2364', 'IC-1', 'Pickup Pending'], { dryRun: true });
  assert.equal(r.body.action, 'would_cancel');
  assert.deepEqual(r.cancelled, []);
});

test('the order\'s own live shipment is never touched', async () => {
  const r = await run({ razorpay_order_id: 'IC-3', status: 'shipped', tracking_id: '2364' }, ['2364', 'IC-3', 'Pickup Pending']);
  assert.equal(r.status, 409);
  assert.deepEqual(r.cancelled, []);
  const none = await run({ razorpay_order_id: 'IC-4', status: 'cod_pending', tracking_id: null }, ['2364', 'IC-4', 'booked']);
  assert.equal(none.status, 409, 'an unshipped live order: this booking may be its only one');
  assert.deepEqual(none.cancelled, []);
});

test('an AWB of another order, unknown, or already moving is not cancelled', async () => {
  assert.equal((await run(shippingElsewhere, ['2364', 'IC-9', 'booked'])).status, 409);
  assert.equal((await run(shippingElsewhere, null)).status, 404);
  const moving = await run(shippingElsewhere, ['2364', 'IC-1', 'In Transit']);
  assert.equal(moving.status, 409);
  assert.deepEqual(moving.cancelled, []);
  const gone = await run(shippingElsewhere, ['2364', 'IC-1', 'Cancelled']);
  assert.equal(gone.body.action, 'already_cancelled');
  assert.deepEqual(gone.cancelled, []);
});
