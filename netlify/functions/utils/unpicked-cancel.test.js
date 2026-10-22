'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { quoteUnpickedCancel } = require('./unpicked-cancel');

const NOW = Date.parse('2026-10-11T10:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400e3).toISOString();

const prepaidBooked = (over = {}) => ({
  id: 'u1', razorpay_order_id: 'IC-20260930-AAAAA', status: 'shipped',
  razorpay_payment_id: 'pay_X', amount_paise: 49900, created_at: daysAgo(11),
  tracking_id: '1234567890', courier_name: 'XpressBees',
  cart_items: [{ title: 'Ikigai', qty: 1, price: 499 }], ...over,
});

test('prepaid, booked, not picked up after 10 days: full refund', () => {
  const q = quoteUnpickedCancel(prepaidBooked(), NOW);
  assert.deepEqual(q, { eligible: true, refundPaise: 49900, partialCod: false, hasAwb: true });
});

test('before 10 days it is not offered', () => {
  assert.equal(quoteUnpickedCancel(prepaidBooked({ created_at: daysAgo(9.9) }), NOW).reason, 'too_soon');
});

test('moved, delivered or in transit by what we know: not offered', () => {
  assert.equal(quoteUnpickedCancel(prepaidBooked({ shipment_moved_at: daysAgo(3) }), NOW).reason, 'moved');
  assert.equal(quoteUnpickedCancel(prepaidBooked({ last_courier_status: 'In Transit' }), NOW).reason, 'moved');
  assert.equal(quoteUnpickedCancel(prepaidBooked({ status: 'delivered' }), NOW).reason, 'closed');
});

test('partial COD refunds the advance, with or without an AWB', () => {
  const pc = { status: 'partial_cod_pending', amount_paise: 5100, razorpay_payment_id: 'OM26X', tracking_id: null,
               cart_items: [{ title: 'A', qty: 1, price: 507, _payment: { mode: 'partial_cod', deposit: 51 } }] };
  assert.deepEqual(quoteUnpickedCancel(prepaidBooked(pc), NOW), { eligible: true, refundPaise: 5100, partialCod: true, hasAwb: false });
  const shipped = { ...pc, status: 'shipped', tracking_id: '999' };
  assert.equal(quoteUnpickedCancel(prepaidBooked(shipped), NOW).eligible, true);
});

test('COD, replacements, prepaid without AWB, and orders already being cancelled are left to their own rules', () => {
  assert.equal(quoteUnpickedCancel(prepaidBooked({ razorpay_payment_id: null, status: 'cod_pending' }), NOW).reason, 'nothing_paid');
  assert.equal(quoteUnpickedCancel(prepaidBooked({ razorpay_order_id: 'IC-R-20260930-AAAAA' }), NOW).reason, 'replacement');
  assert.equal(quoteUnpickedCancel(prepaidBooked({ source: 'replacement' }), NOW).reason, 'replacement');
  assert.equal(quoteUnpickedCancel(prepaidBooked({ tracking_id: null, status: 'paid' }), NOW).reason, 'late_cancel_covers');
  assert.equal(quoteUnpickedCancel(prepaidBooked({ cancellation_requested_at: daysAgo(1) }), NOW).reason, 'already_requested');
  assert.equal(quoteUnpickedCancel(prepaidBooked({ late_cancel_at: daysAgo(1) }), NOW).reason, 'already_requested');
});

// ── The endpoint ────────────────────────────────────────────────────────────

function fakeDb(order) {
  const state = { order: { ...order }, updates: [] };
  const db = {
    state,
    auth: { getUser: async (t) => (t === 'good' ? { data: { user: { email: order.customer_email } }, error: null } : { data: { user: null }, error: new Error('bad') }) },
    from() {
      const filters = [];
      let patch = null;
      const matches = () => filters.every(([k, v, op]) => (op === 'is' ? (state.order[k] ?? null) === v : state.order[k] === v));
      const q = {
        select() { return q; },
        update(p) { patch = p; return q; },
        eq(k, v) { filters.push([k, v, 'eq']); return q; },
        is(k, v) { filters.push([k, v, 'is']); return q; },
        maybeSingle: async () => ({ data: matches() ? { ...state.order } : null, error: null }),
        then(resolve) {
          let data = [];
          if (patch && matches()) { Object.assign(state.order, patch); state.updates.push(patch); data = [{ id: state.order.id }]; }
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return q;
    },
  };
  return db;
}

const { handler } = require('../cancel-unpicked-order');
const call = (db, handleOne, alerts = []) => handler(
  { httpMethod: 'POST', headers: { authorization: 'Bearer good' }, body: JSON.stringify({ order_id: 'u1' }) },
  {}, { db, handleOne, alertOwner: async (o, line) => { alerts.push(line); } },
);
// The real rule reads the clock; these orders are well past 10 days.
const order = prepaidBooked({ customer_email: 'a@b.in', created_at: '2026-01-01T00:00:00Z' });

test('courier stopped it: cancelled, refund message', async () => {
  process.env.ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || 'test-secret-for-signing-0123456789';
  const db = fakeDb(order);
  let ran = 0;
  const res = await call(db, async () => { ran++; return { outcome: 'cancelled', reason: 'XpressBees cancelled' }; });
  assert.equal(res.statusCode, 200);
  assert.match(JSON.parse(res.body).message, /full refund of ₹499/);
  assert.equal(ran, 1);
  assert.ok(db.state.order.cancellation_requested_at, 'claimed');
});

test('a second tap does not run the cancel again', async () => {
  const db = fakeDb({ ...order, cancellation_requested_at: '2026-10-11T09:00:00Z' });
  let ran = 0;
  const res = await call(db, async () => { ran++; return { outcome: 'cancelled' }; });
  assert.equal(res.statusCode, 422);
  assert.equal(ran, 0);
});

test('courier says it moved: nothing cancelled, claim released', async () => {
  const db = fakeDb(order);
  const res = await call(db, async () => ({ outcome: 'skipped', reason: 'courier says "Picked Up"' }));
  assert.equal(res.statusCode, 422);
  assert.equal(JSON.parse(res.body).reason, 'moved');
  assert.equal(db.state.order.cancellation_requested_at, null);
});

test('no courier answer: kept as a request for the owner, no cancel claimed', async () => {
  const db = fakeDb(order);
  const alerts = [];
  const res = await call(db, async () => ({ outcome: 'needs_manual', reason: 'no courier answered' }), alerts);
  assert.equal(res.statusCode, 202);
  assert.equal(JSON.parse(res.body).outcome, 'requested');
  assert.equal(alerts.length, 1);
  assert.ok(db.state.order.cancellation_requested_at);
});

test('someone else\'s order is refused before anything runs', async () => {
  const db = fakeDb({ ...order });
  db.auth.getUser = async () => ({ data: { user: { email: 'other@x.in' } }, error: null });
  let ran = 0;
  const res = await call(db, async () => { ran++; return { outcome: 'cancelled' }; });
  assert.equal(res.statusCode, 403);
  assert.equal(ran, 0);
});
