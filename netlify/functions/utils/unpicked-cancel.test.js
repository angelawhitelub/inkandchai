'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { quoteUnpickedCancel, unpickedCancelFrom, UNPICKED_DAYS } = require('./unpicked-cancel');

const NOW = Date.parse('2026-10-11T10:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400e3).toISOString();

const prepaidBooked = (over = {}) => ({
  id: 'u1', razorpay_order_id: 'IC-20260930-AAAAA', status: 'shipped',
  razorpay_payment_id: 'pay_X', amount_paise: 49900, created_at: daysAgo(8),
  tracking_id: '1234567890', courier_name: 'XpressBees',
  cart_items: [{ title: 'Ikigai', qty: 1, price: 499 }], ...over,
});

test('prepaid, booked, not picked up after 7 days: full refund', () => {
  const q = quoteUnpickedCancel(prepaidBooked(), NOW);
  assert.deepEqual(q, { eligible: true, refundPaise: 49900, partialCod: false, hasAwb: true });
});

test('the rule is 7 days: not offered before, offered from then', () => {
  assert.equal(UNPICKED_DAYS, 7);
  assert.equal(quoteUnpickedCancel(prepaidBooked({ created_at: daysAgo(6.9) }), NOW).reason, 'too_soon');
  assert.equal(quoteUnpickedCancel(prepaidBooked({ created_at: daysAgo(7) }), NOW).eligible, true);
  assert.equal(unpickedCancelFrom(prepaidBooked({ created_at: daysAgo(2) })), NOW + 5 * 86400e3);
});

test('prepaid never booked (no AWB): full refund too, late cancel refuses it', () => {
  const q = quoteUnpickedCancel(prepaidBooked({ tracking_id: null, courier_name: null, status: 'paid' }), NOW);
  assert.deepEqual(q, { eligible: true, refundPaise: 49900, partialCod: false, hasAwb: false });
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

test('COD, replacements, and orders already being cancelled are left to their own rules', () => {
  assert.equal(quoteUnpickedCancel(prepaidBooked({ razorpay_payment_id: null, status: 'cod_pending' }), NOW).reason, 'nothing_paid');
  assert.equal(quoteUnpickedCancel(prepaidBooked({ razorpay_order_id: 'IC-R-20260930-AAAAA' }), NOW).reason, 'replacement');
  assert.equal(quoteUnpickedCancel(prepaidBooked({ source: 'replacement' }), NOW).reason, 'replacement');
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
// The real rule reads the clock; these orders are well past 7 days.
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

// ── "Cancel until shipped" switch (utils/cancel-window) ───────────────────────
test('window open: a paid order with no AWB is cancellable at once, marked early', () => {
  const fresh = prepaidBooked({ tracking_id: null, courier_name: null, status: 'paid', created_at: daysAgo(0.2) });
  assert.equal(quoteUnpickedCancel(fresh, NOW).reason, 'too_soon');
  const q = quoteUnpickedCancel(fresh, NOW, { untilShipped: true });
  assert.equal(q.eligible, true);
  assert.equal(q.early, true);
  assert.equal(q.refundPaise, 49900);
  const partial = quoteUnpickedCancel(prepaidBooked({ tracking_id: null, status: 'partial_cod_pending', advance_paid_paise: 5000, created_at: daysAgo(1) }), NOW, { untilShipped: true });
  assert.equal(partial.eligible, true);
  assert.equal(partial.partialCod, true);
});

test('window open does not reach shipped orders, COD or orders past the rule', () => {
  // Has an AWB: shipped, so the switch does not apply.
  assert.equal(quoteUnpickedCancel(prepaidBooked({ created_at: daysAgo(1) }), NOW, { untilShipped: true }).reason, 'too_soon');
  // COD: nothing paid, cancel-order handles it until pickup.
  assert.equal(quoteUnpickedCancel(prepaidBooked({ tracking_id: null, status: 'cod_pending', razorpay_payment_id: null, created_at: daysAgo(1) }), NOW, { untilShipped: true }).reason, 'nothing_paid');
  // Past 7 days it is the ordinary unpicked cancel, not "early".
  assert.equal(quoteUnpickedCancel(prepaidBooked({ tracking_id: null, status: 'paid', created_at: daysAgo(9) }), NOW, { untilShipped: true }).early, undefined);
});

const freshNoAwb = prepaidBooked({ customer_email: 'a@b.in', tracking_id: null, courier_name: null, status: 'paid',
  created_at: new Date(Date.now() - 3600e3).toISOString(), xpressbees_feed_at: new Date().toISOString() });
const callEarly = (db, handleOne, panel) => handler(
  { httpMethod: 'POST', headers: { authorization: 'Bearer good' }, body: JSON.stringify({ order_id: 'u1' }) },
  {}, { db, handleOne, untilShipped: true, xbPanelIndex: async () => panel, alertOwner: async () => {} },
);

test('window open, queued in the XpressBees panel: cancelled through the usual path', async () => {
  process.env.ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || 'test-secret-for-signing-0123456789';
  const db = fakeDb(freshNoAwb);
  let seen = null;
  const res = await callEarly(db, async (e, sb, o) => { seen = o; return { outcome: 'cancelled', reason: 'no AWB' }; },
    new Map([['IC-20260930-AAAAA', { state: 'queued', awb: null }]]));
  assert.equal(res.statusCode, 200);
  assert.equal(seen.xpressbees_feed_at, null, 'panel checked, so handleOne need not stop for it');
  assert.match(db.state.order.cancellation_request_note, /^Customer cancel: not picked up — before shipping/);
});

test('window open, but the XpressBees panel already booked it: refused, nothing claimed', async () => {
  const db = fakeDb(freshNoAwb);
  let ran = 0;
  const res = await callEarly(db, async () => { ran++; return { outcome: 'cancelled' }; },
    new Map([['IC-20260930-AAAAA', { state: 'booked', awb: '1434' }]]));
  assert.equal(res.statusCode, 422);
  assert.equal(JSON.parse(res.body).reason, 'booked');
  assert.equal(ran, 0);
  assert.ok(!db.state.order.cancellation_requested_at);
});

test('window closed: a fresh paid order is not cancellable here', async () => {
  const db = fakeDb(freshNoAwb);
  const res = await handler(
    { httpMethod: 'POST', headers: { authorization: 'Bearer good' }, body: JSON.stringify({ order_id: 'u1' }) },
    {}, { db, untilShipped: false, handleOne: async () => ({ outcome: 'cancelled' }) },
  );
  assert.equal(res.statusCode, 422);
  assert.equal(JSON.parse(res.body).reason, 'too_soon');
});

// Owner, 12 Nov 2026: booked but not picked up = cancellable on WhatsApp.
test('pickupPending: a booked prepaid order is cancellable at once, full refund', () => {
  const q = quoteUnpickedCancel(prepaidBooked({ created_at: daysAgo(1) }), NOW, { pickupPending: true });
  assert.deepEqual(q, { eligible: true, refundPaise: 49900, partialCod: false, hasAwb: true, pickupPending: true });
  // Without the option the 7-day rule still stands (My Orders).
  assert.equal(quoteUnpickedCancel(prepaidBooked({ created_at: daysAgo(1) }), NOW).reason, 'too_soon');
});

test('pickupPending: a booked COD order is cancellable, nothing to refund', () => {
  const cod = prepaidBooked({ razorpay_payment_id: null, amount_paise: 61500, created_at: daysAgo(1) });
  const q = quoteUnpickedCancel(cod, NOW, { pickupPending: true });
  assert.equal(q.eligible, true);
  assert.equal(q.refundPaise, 0);
  assert.equal(q.pickupPending, true);
  // COD past 7 days still waiting for pickup is covered too.
  assert.equal(quoteUnpickedCancel({ ...cod, created_at: daysAgo(9) }, NOW, { pickupPending: true }).pickupPending, true);
});

test('pickupPending never covers an unbooked COD order or a parcel that moved', () => {
  const cod = prepaidBooked({ razorpay_payment_id: null, created_at: daysAgo(1) });
  assert.equal(quoteUnpickedCancel({ ...cod, tracking_id: null, status: 'cod_pending' }, NOW, { pickupPending: true }).reason, 'nothing_paid');
  assert.equal(quoteUnpickedCancel({ ...cod, last_courier_status: 'In Transit' }, NOW, { pickupPending: true }).reason, 'moved');
  assert.equal(quoteUnpickedCancel({ ...cod, shipment_moved_at: daysAgo(0.5) }, NOW, { pickupPending: true }).reason, 'moved');
  assert.equal(quoteUnpickedCancel({ ...cod, cancellation_requested_at: daysAgo(0.1) }, NOW, { pickupPending: true }).reason, 'already_requested');
});

test('the Diwali pickup notice runs through its IST date, then stops by itself', () => {
  const { pickupDelayNotice } = require('./pickup-delay');
  const env = { PICKUP_DELAY_UNTIL: '2026-11-13' };
  assert.match(pickupDelayNotice(Date.parse('2026-11-13T18:00:00Z'), env), /Diwali/);   // 23:30 IST on the 13th
  assert.equal(pickupDelayNotice(Date.parse('2026-11-13T18:31:00Z'), env), '');         // 00:01 IST on the 14th
  assert.equal(pickupDelayNotice(Date.parse('2026-11-12T10:00:00Z'), { PICKUP_DELAY_UNTIL: '' }), '');
  assert.equal(pickupDelayNotice(Date.parse('2026-11-12T10:00:00Z'), { ...env, PICKUP_DELAY_NOTICE: 'Custom.' }), 'Custom.');
});

test('WhatsApp pickup-pending cancel of a COD order: courier asked, customer-request reason, no refund wording', async () => {
  process.env.ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || 'test-secret-for-signing-0123456789';
  const { cancelUnpickedOrder } = require('../cancel-unpicked-order');
  const cod = prepaidBooked({ razorpay_payment_id: null, amount_paise: 61500, created_at: new Date(Date.now() - 86400e3).toISOString() });
  const db = fakeDb(cod);
  let opts = null;
  const r = await cancelUnpickedOrder(db, cod, {
    pickupPending: true, untilShipped: false,
    handleOne: async (ev, sb, o, o2) => { opts = o2; return { outcome: 'cancelled', reason: 'XpressBees cancelled' }; },
  });
  assert.equal(r.status, 200);
  assert.match(r.body.message, /Cash on Delivery, there is nothing to refund/);
  assert.equal(opts.cancelReason, 'customer_request');
  assert.match(db.state.order.cancellation_request_note, /^Customer cancel: not picked up/);
});
