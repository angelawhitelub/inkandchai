'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stageOf, normalise, trackReturns } = require('./return-tracking');
const { describeReturn, returnsContext } = require('./return-bot-context');
const { _test: job } = require('../return-tracking-scheduled');

// ── stage vocabulary ───────────────────────────────────────────────────────

test('courier wording maps to the reverse-pickup stage', () => {
  assert.equal(stageOf('Pending Pickup'), 'awaiting_pickup');
  assert.equal(stageOf('pickup_scheduled'), 'awaiting_pickup');
  assert.equal(stageOf('Pickup Failed - customer not available'), 'pickup_failed');
  assert.equal(stageOf('Picked Up'), 'picked_up');
  assert.equal(stageOf('In Transit'), 'in_transit');
  assert.equal(stageOf('out for delivery'), 'out_for_delivery');
  assert.equal(stageOf('Delivered'), 'delivered');
  assert.equal(stageOf('Undelivered'), 'in_transit');
  assert.equal(stageOf('Cancelled'), 'cancelled');
  assert.equal(stageOf(''), 'unknown');
});

test('RTO on a reverse shipment goes back to the CUSTOMER, never counts as received', () => {
  assert.equal(stageOf('RTO Delivered'), 'returned_to_customer');
  assert.equal(stageOf('rto in transit'), 'in_transit');
  const v = normalise({ status: 'rto', history: [
    { status_code: 'RT-DL', message: 'RTO Delivered', event_time: '2026-10-04 12:00' },
    { status_code: 'PUD', message: 'Picked Up', event_time: '2026-10-01 12:00' },
  ] }, 'nimbuspost');
  assert.equal(v.stage, 'returned_to_customer');
  assert.equal(v.delivered_at, '');
});

test('a delivered scan in the history wins over a lagging headline', () => {
  const v = normalise({ status: 'in transit', history: [
    { status_code: 'IT', message: 'In Transit', location: 'Gurgaon Hub', event_time: '2026-10-02 09:00' },
    { status_code: 'DL', message: 'Delivered', location: 'Delhi', event_time: '2026-10-03 14:30' },
  ] }, 'xpressbees');
  assert.equal(v.stage, 'delivered');
  assert.equal(v.delivered_at, '2026-10-03T09:00:00.000Z');   // 14:30 IST
  assert.equal(v.last_scan, 'Delivered · Delhi');
  assert.equal(v.history[0].stage, 'delivered');
});

test('a stale cancel in the history does not override a later pickup', () => {
  const v = normalise({ status: 'picked up', history: [
    { message: 'Cancelled', event_time: '2026-10-01 09:00' },
    { message: 'Picked Up', event_time: '2026-10-02 09:00' },
  ] }, 'nimbuspost');
  assert.equal(v.stage, 'picked_up');
});

// ── trackReturns ───────────────────────────────────────────────────────────

test('NimbusPost first, XpressBees for AWBs it does not know, failures reported per AWB', async () => {
  const xbCalls = [];
  const out = await trackReturns(['111', '222', '333'], {
    npTrackMany: async () => new Map([['111', { awb_number: '111', status: 'Picked Up', history: [] }]]),
    xbTrack: async (awb) => {
      xbCalls.push(awb);
      if (awb === '333') throw new Error('Record not found');
      return { awb_number: awb, status: 'pending pickup', history: [] };
    },
  });
  assert.deepEqual(xbCalls, ['222', '333']);
  assert.equal(out.get('111').source, 'nimbuspost');
  assert.equal(out.get('111').stage, 'picked_up');
  assert.equal(out.get('222').source, 'xpressbees');
  assert.equal(out.get('333').stage, 'unknown');
  assert.match(out.get('333').error, /Record not found/);
});

test('a payload for a different AWB is never used', async () => {
  const out = await trackReturns(['111'], {
    npTrackMany: async () => new Map([['111', { awb_number: '999', status: 'Delivered', history: [] }]]),
    xbTrack: async () => ({ awb_number: '998', status: 'Delivered', history: [] }),
  });
  assert.equal(out.get('111').stage, 'unknown');
});

// ── refresh job ────────────────────────────────────────────────────────────

/** Just enough supabase-js: select/update with eq/is/gte/order/limit, and missing columns. */
function fakeDb(rows, { columns } = {}) {
  const updates = [];
  const db = {
    updates,
    from() {
      const st = { filters: [], patch: null };
      const q = {
        select() { return q; },
        update(p) { st.patch = p; return q; },
        eq(k, v) { st.filters.push((r) => String(r[k]) === String(v)); return q; },
        is(k, v) { st.filters.push((r) => (r[k] ?? null) === v); return q; },
        gte() { return q; }, order() { return q; }, limit() { return q; },
        then(res, rej) {
          const run = () => {
            const hit = rows.filter((r) => st.filters.every((f) => f(r)));
            if (!st.patch) return { data: hit, error: null };
            const bad = columns && Object.keys(st.patch).find((k) => !columns.has(k));
            if (bad) return { data: null, error: { message: `Could not find the '${bad}' column of 'return_requests'` } };
            hit.forEach((r) => Object.assign(r, st.patch));
            updates.push({ ids: hit.map((r) => r.id), patch: st.patch });
            return { data: hit.map((r) => ({ id: r.id })), error: null };
          };
          return Promise.resolve(run()).then(res, rej);
        },
      };
      return q;
    },
  };
  return db;
}

const DELIVERED = { stage: 'delivered', status: 'Delivered', last_scan: 'Delivered · Delhi', last_scan_at: '2026-10-03T09:00:00.000Z', delivered_at: '2026-10-03T09:00:00.000Z', history: [] };

test('backfills an R-RET AWB only onto a pushed return without one', async () => {
  const rows = [
    { id: 'a', status: 'pushed_to_nimbus', awb: null, order_display_id: 'IC-20260805-H90XH' },
    { id: 'b', status: 'approved', awb: null, order_display_id: 'IC-20260806-AAAAA' },
  ];
  const db = fakeDb(rows);
  const s = await job.refresh(db, {
    awbMap: async () => new Map([
      ['R-RET-20260805-H90XH', { awb: '253713050115882', courier: 'Xpressbees' }],
      ['R-RET-20260806-AAAAA', { awb: '1', courier: 'X' }],
    ]),
    trackReturns: async () => new Map(),
    ownerAlert: async () => assert.fail('no alert expected'),
  });
  assert.deepEqual(s.awb_backfilled, ['IC-20260805-H90XH → 253713050115882']);
  assert.equal(rows[0].awb, '253713050115882');
  assert.equal(rows[0].status, 'pickup_scheduled');
  assert.equal(rows[1].awb, null);
});

test('alerts the owner once when a return is delivered back, and never moves money', async () => {
  const rows = [{ id: 'a', status: 'pickup_scheduled', awb: '555', order_display_id: 'IC-1', refund_status: 'awaiting_return_delivery', refund_amount_paise: 49900 }];
  const db = fakeDb(rows);
  const alerts = [];
  const deps = { trackReturns: async () => new Map([['555', DELIVERED]]), ownerAlert: async (t) => alerts.push(t), awbMap: async () => new Map() };
  const s1 = await job.refresh(db, deps);
  assert.deepEqual(s1.alerted, ['IC-1']);
  assert.equal(rows[0].return_delivered_at, DELIVERED.delivered_at);
  assert.equal(rows[0].refund_status, 'awaiting_return_delivery');   // untouched
  assert.match(alerts[0], /Return received/);
  // Received rows are not re-tracked, and the claim stops a second alert anyway.
  rows[0].return_delivered_at = null;
  await job.refresh(db, deps);
  assert.equal(alerts.length, 1);
});

test('without the tracking columns: no save, no alert, and it says which SQL is missing', async () => {
  const rows = [{ id: 'a', status: 'pickup_scheduled', awb: '555', order_display_id: 'IC-1' }];
  const db = fakeDb(rows, { columns: new Set(['awb', 'courier_name', 'status']) });
  const alerts = [];
  const s = await job.refresh(db, { trackReturns: async () => new Map([['555', DELIVERED]]), ownerAlert: async (t) => alerts.push(t), awbMap: async () => new Map() });
  assert.equal(alerts.length, 0);
  assert.equal(s.saved, 0);
  assert.ok(s.columns_missing.includes('delivered_alerted_at'));
  assert.ok(s.columns_missing.includes('tracking_status'));
});

test('rejected returns are never tracked', async () => {
  const rows = [{ id: 'a', status: 'rejected', awb: '555' }];
  let asked = false;
  await job.refresh(fakeDb(rows), { trackReturns: async () => { asked = true; return new Map(); }, awbMap: async () => new Map() });
  assert.equal(asked, false);
});

// ── bot context ────────────────────────────────────────────────────────────

test('bot context says delivered back to us, and the refund only as the row states it', () => {
  const ret = { order_display_id: 'IC-1', status: 'pickup_scheduled', awb: '555', courier_name: 'Xpressbees', refund_status: 'manual_payout_pending', refund_amount_paise: 84900, created_at: '2026-10-01T00:00:00Z' };
  const txt = describeReturn(ret, DELIVERED);
  assert.match(txt, /AWB 555/);
  assert.match(txt, /DELIVERED BACK TO US/);
  assert.match(txt, /ask the customer for their UPI ID/);
  assert.doesNotMatch(txt, /has been issued/);
});

test('bot context reads saved tracking when fresh and skips the live call', async () => {
  const rows = [{ id: 'a', order_display_id: 'IC-1', status: 'pickup_scheduled', awb: '555', customer_phone: '9876543210',
    tracking_status: 'in_transit', tracking_last_scan: 'In Transit · Gurgaon', tracking_checked_at: new Date().toISOString(), created_at: new Date().toISOString() }];
  const db = fakeDb(rows);
  db.from = ((orig) => () => { const q = orig(); q.or = () => q; return q; })(db.from.bind(db));
  let live = false;
  const txt = await returnsContext(db, '919876543210', [], { trackReturns: async () => { live = true; return new Map(); } });
  assert.equal(live, false);
  assert.match(txt, /On the way to us — latest scan: In Transit · Gurgaon/);
});
