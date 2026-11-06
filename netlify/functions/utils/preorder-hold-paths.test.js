'use strict';

// The courier paths themselves: a pre-order stops at the door of each one.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.XPRESSBEES_PICKUP_PINCODE = process.env.XPRESSBEES_PICKUP_PINCODE || '110006';
process.env.XPRESSBEES_PICKUP_ADDRESS = process.env.XPRESSBEES_PICKUP_ADDRESS || 'Test';
process.env.NIMBUS_AUTO_PUSH = 'on';
const SOON = '2099-11-20';

const preorder = (over = {}) => ({
  id: 'u1', razorpay_order_id: 'IC-1', status: 'paid', created_at: '2026-11-01T06:00:00Z',
  customer_name: 'Riya', customer_phone: '919876543210', customer_address: 'House 1, Delhi 110006',
  amount_paise: 49900, cart_items: [{ slug: 'soon', title: 'Soon', qty: 1, price: 499, _release: SOON }],
  ...over,
});

/** Orders on `orders`; books read through allReleases fail, so the line stamp decides. */
function fakeDb(rows) {
  const updates = [];
  const from = (table) => {
    const b = {
      select: () => b, eq: () => b, is: () => b, in: () => b, gte: () => b, lt: () => b, gt: () => b, order: () => b, limit: () => b,
      or: () => b, range: async () => ({ data: null, error: { message: 'books unavailable in this test' } }),
      update: (patch) => { updates.push(patch); return b; },
      then: (ok, bad) => Promise.resolve({ data: table === 'orders' ? rows : [], error: null }).then(ok, bad),
    };
    return b;
  };
  return { from, updates };
}

test('automatic NimbusPost push: not pushed, and nothing is claimed', async () => {
  const { pushToNimbusOnce } = require('./nimbus-push-once');
  const db = fakeDb([]);
  const out = await pushToNimbusOnce(db, preorder());
  assert.equal(out.pushed, false);
  assert.equal(out.reason, 'preorder_hold');
  assert.deepEqual(db.updates, [], 'an unclaimed order can still go on release day');
});

test('XpressBees booking list: a pre-order is held, not ready', async () => {
  const ship = require('../xpressbees-ship');
  assert.equal(typeof ship.processOrders, 'function');
  const out = await ship.processOrders(['IC-1'], { supabase: fakeDb([preorder()]), dry_run: true, quoteStore: null, force: true });
  assert.equal(out.booked.length, 0);
  assert.equal(out.failed.length, 0);
  assert.equal(out.skipped[0].kind, 'preorder', 'force does not get past it');
});

test('DTDC sheet: a pre-order is left off and named', async () => {
  const { _test } = require('../admin-dtdc-upload');
  const out = await _test.build({}, { supabase: fakeDb([preorder()]), toWooOrder: async () => { throw new Error('must not be built'); } });
  assert.equal(out.rows.length, 0);
  assert.match(out.skipped[0].error, /pre-order/);
});

test('Shiprocket checkout push: skipped on the line stamp', async () => {
  const { autoPushOrderToShiprocket } = require('./shiprocket');
  const out = await autoPushOrderToShiprocket({ inkOrderId: 'IC-1', cartItems: preorder().cart_items });
  assert.equal(out.skipped, true);
  assert.match(out.reason, /pre-order/);
});
