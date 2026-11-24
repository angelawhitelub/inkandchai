'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handle, AUTO_DAYS } = require('../unpicked-auto-cancel-scheduled')._test;

process.env.ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || 'test-secret-for-unit-tests';
const DAY = 86400000;
const now = Date.parse('2026-11-24T06:00:00Z');
const mk = (id, daysOld, o = {}) => ({
  id, razorpay_order_id: `IC-${id}`, status: 'shipped', tracking_id: `AWB${id}`, courier_name: 'Xpressbees',
  created_at: new Date(now - daysOld * DAY).toISOString(), amount_paise: 50000, razorpay_payment_id: 'pay_x',
  cart_items: [{ title: 'Book', qty: 1 }], shipment_moved_at: null, cancelled_at: null, cancellation_requested_at: null, late_cancel_at: null, ...o,
});

function fakeDb(rows) {
  return {
    from() {
      const q = { filters: [], patch: null };
      const api = {
        select() { return api; }, order() { return api; }, limit() { return api; },
        in(k, vs) { q.filters.push((r) => vs.includes(r[k])); return api; },
        lte(k, v) { q.filters.push((r) => r[k] <= v); return api; },
        gte(k, v) { q.filters.push((r) => r[k] >= v); return api; },
        eq(k, v) { q.filters.push((r) => r[k] === v); return api; },
        is(k, v) { q.filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return api; },
        update(p) { q.patch = p; return api; },
        then(res, rej) {
          const hits = rows.filter((r) => q.filters.every((f) => f(r)));
          if (q.patch) hits.forEach((r) => Object.assign(r, q.patch));
          return Promise.resolve({ data: q.patch ? hits.map((r) => ({ id: r.id })) : hits, error: null }).then(res, rej);
        },
      };
      return api;
    },
  };
}

const base = (rows, extra = {}) => ({
  db: fakeDb(rows), now, skipAuth: true, log: {}, switch: { on: true },
  preorderChecker: async () => () => null,
  alertOwner: async () => {},
  ...extra,
});

test('off by default: nothing is read or cancelled', async () => {
  const rows = [mk('a', 12)];
  let calls = 0;
  const out = JSON.parse((await handle({}, base(rows, { switch: { on: false }, handleOne: async () => { calls++; return {}; } }))).body);
  assert.equal(out.off, true);
  assert.equal(calls, 0);
});

test('only orders past 10 days are cancelled; younger, moved and held ones are left', async () => {
  const rows = [mk('old', 11), mk('young', 9), mk('moved', 15, { shipment_moved_at: new Date(now - 3 * DAY).toISOString() }), mk('held', 14)];
  const seen = [];
  const handleOne = async (ev, db, order, opts) => { seen.push([order.razorpay_order_id, opts.dryRun, opts.cancelReason]); return { outcome: 'cancelled', refund: { status: 'issued', amount_rs: 500 } }; };
  const alerts = [];
  const out = JSON.parse((await handle({}, base(rows, { handleOne, preorderChecker: async () => (o) => (o.id === 'held' ? { kind: 'handling' } : null), alertOwner: async (t) => alerts.push(t) }))).body);
  assert.deepEqual(seen, [['IC-old', false, 'out_of_stock']]);
  assert.deepEqual(out.cancelled, ['IC-old']);
  assert.match(alerts[0], /IC-old · refund ₹500/);
  assert.equal(AUTO_DAYS, 10);
});

test('a parcel the courier will not stop is handed back untouched and the owner told', async () => {
  const rows = [mk('stuck', 20)];
  const alerts = [];
  const out = JSON.parse((await handle({}, base(rows, { handleOne: async () => ({ outcome: 'needs_manual', reason: 'no courier answered' }), alertOwner: async (t) => alerts.push(t) }))).body);
  assert.deepEqual(out.stuck, ['IC-stuck']);
  assert.equal(rows[0].cancellation_requested_at, null);
  assert.match(alerts[0], /Could not stop 1/);
});

test('an order tried in the last day is not tried again', async () => {
  const rows = [mk('x', 20)];
  let calls = 0;
  await handle({}, base(rows, { log: { x: { at: new Date(now - 3600000).toISOString() } }, handleOne: async () => { calls++; return { outcome: 'cancelled' }; } }));
  assert.equal(calls, 0);
});

test('at most 10 a run, oldest first', async () => {
  const rows = Array.from({ length: 14 }, (_, i) => mk(`o${i}`, 30 - i));
  const seen = [];
  const out = JSON.parse((await handle({}, base(rows, { handleOne: async (e, d, o) => { seen.push(o.id); return { outcome: 'cancelled' }; } }))).body);
  assert.equal(seen.length, 10);
  assert.equal(seen[0], 'o0');
  assert.equal(out.left, 4);
});

test('XpressBees panel booking whose AWB never came back is left to the owner', async () => {
  const rows = [mk('pnl1', 12, { status: 'confirmed', tracking_id: null, xpressbees_feed_at: new Date(now - 11 * DAY).toISOString() })];
  let calls = 0;
  const out = JSON.parse((await handle({}, base(rows, {
    xbPanelIndex: async () => new Map([['IC-PNL1', { state: 'booked' }]]),
    handleOne: async () => { calls++; return { outcome: 'cancelled' }; },
  }))).body);
  assert.equal(calls, 0);
  assert.deepEqual(out.stuck, ['IC-pnl1']);
});

test('dry run changes nothing and totals the refunds', async () => {
  const rows = [mk('d', 13)];
  const out = JSON.parse((await handle({ httpMethod: 'POST', body: JSON.stringify({ dry_run: true }) }, base(rows, { switch: { on: false },
    handleOne: async (e, d, o, opts) => { assert.equal(opts.dryRun, true); return { outcome: 'would_cancel', refund: { via: 'gateway', amount_rs: 500 } }; } }))).body);
  assert.equal(out.would_cancel, 1);
  assert.equal(out.would_refund_rs, 500);
  assert.equal(rows[0].cancellation_requested_at, null);
});
