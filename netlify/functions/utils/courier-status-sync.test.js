'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planUpdate } = require('./courier-status-sync');

const NOW = '2026-10-12T05:00:00.000Z';

test('IC-20260919-IUPN2: Amazon says Delivered -> delivered, on the day Amazon delivered it', () => {
  const { fields, to } = planUpdate({ status: 'shipped' }, { status: 'Delivered', state: 'moved', at: '2026-09-24T09:54:31.000Z' }, NOW);
  assert.equal(to, 'delivered');
  assert.equal(fields.status, 'delivered');
  assert.equal(fields.delivered_at, '2026-09-24T09:54:31.000Z');
  assert.equal(fields.shipment_moved_at, '2026-09-24T09:54:31.000Z');
  assert.equal(fields.last_courier_status, 'Delivered');
});

test('no courier time: now for a recent parcel, blank for an old one; a future time is not trusted', () => {
  const recent = { status: 'shipped', shipped_at: '2026-10-08T00:00:00Z' };
  const old = { status: 'shipped', shipped_at: '2026-08-20T00:00:00Z' };
  assert.equal(planUpdate(recent, { status: 'Delivered', state: 'moved' }, NOW).fields.delivered_at, NOW);
  assert.equal(planUpdate(recent, { status: 'Delivered', state: 'moved', at: '2027-01-01T00:00:00Z' }, NOW).fields.delivered_at, NOW);
  const o = planUpdate(old, { status: 'delivered', state: 'moved' }, NOW);
  assert.equal(o.to, 'delivered');
  assert.equal('delivered_at' in o.fields, false, 'an August parcel is not stamped as delivered today');
  assert.equal(planUpdate(old, { status: 'Delivered', state: 'moved', at: '2026-08-25T08:00:00.000Z' }, NOW).fields.delivered_at, '2026-08-25T08:00:00.000Z');
});

test('out for delivery moves forward; in transit only stamps movement', () => {
  assert.equal(planUpdate({ status: 'shipped' }, { status: 'Out For Delivery', state: 'moved' }, NOW).to, 'out_for_delivery');
  const transit = planUpdate({ status: 'shipped' }, { status: 'In Transit', state: 'moved' }, NOW);
  assert.equal(transit.to, null);
  assert.equal(transit.fields.status, undefined);
  assert.equal(transit.fields.shipment_moved_at, NOW);
});

test('never backwards, never out of a terminal or money state, RTO is text only', () => {
  assert.equal(planUpdate({ status: 'out_for_delivery' }, { status: 'Out For Delivery', state: 'moved' }, NOW).to, null);
  assert.equal(planUpdate({ status: 'cancelled' }, { status: 'Delivered', state: 'moved' }, NOW).to, null);
  assert.equal(planUpdate({ status: 'refund_pending' }, { status: 'Delivered', state: 'moved' }, NOW).to, null);
  const rto = planUpdate({ status: 'shipped' }, { status: 'RTO In Transit', state: 'moved' }, NOW);
  assert.equal(rto.to, null);
  assert.equal(rto.fields.last_courier_status, 'RTO In Transit');
  assert.equal(planUpdate({ status: 'shipped' }, { status: 'RTO Delivered', state: 'moved' }, NOW).to, null);
  assert.equal(planUpdate({ status: 'shipped' }, { status: 'Undelivered', state: 'moved' }, NOW).to, null);
});

test('no answer only stamps the check time; waiting changes nothing else', () => {
  assert.deepEqual(planUpdate({ status: 'shipped' }, undefined, NOW).fields, { last_courier_status_at: NOW });
  assert.deepEqual(planUpdate({ status: 'shipped' }, { status: '', state: 'unknown' }, NOW).fields, { last_courier_status_at: NOW });
  const waiting = planUpdate({ status: 'shipped' }, { status: 'Pickup Scheduled', state: 'waiting' }, NOW);
  assert.equal(waiting.to, null);
  assert.equal(waiting.fields.shipment_moved_at, undefined);
});

test('the job writes only through the guarded update, and a dry run writes nothing', async () => {
  const { run } = require('../courier-status-sync-scheduled')._test;
  const writes = [];
  const rows = [{ id: 'a', razorpay_order_id: 'IC-A', status: 'shipped', tracking_id: '372685510045', courier_name: 'Amazon Shipping' },
    { id: 'b', razorpay_order_id: 'IC-B', status: 'shipped', tracking_id: '999', courier_name: 'DTDC' }];
  const chain = (result) => new Proxy({}, { get: (_, k) => (k === 'then' ? (r) => r(result) : () => chain(result)) });
  const db = {
    from: () => ({
      select: () => chain({ data: rows, error: null }),
      update: (fields) => { writes.push(fields); return chain({ error: null }); },
    }),
  };
  const check = async () => new Map([['a', { status: 'Delivered', state: 'moved', at: '2026-09-24T09:54:31.000Z' }]]);
  const out = await run(db, { check, now: new Date(NOW) });
  assert.equal(out.to_delivered, 1);
  assert.equal(out.no_answer, 1);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].status, 'delivered');
  writes.length = 0;
  const dry = await run(db, { check, dryRun: true, now: new Date(NOW) });
  assert.equal(dry.changes[0].order, 'IC-A');
  assert.equal(writes.length, 0);
});

const { _test: { runSelected } } = require('../courier-status-sync-scheduled');

function fakeDb(rows) {
  const writes = [];
  const chain = (result) => {
    const c = { in: () => c, eq: () => c, not: () => c, then: (ok) => ok(result) };
    return c;
  };
  return {
    writes,
    from: () => ({
      select: () => chain({ data: rows, error: null }),
      update: (fields) => { writes.push(fields); return chain({ error: null }); },
    }),
  };
}

const LATER = new Date('2026-11-05T00:00:00Z');
const answers = (map) => async (orders) => new Map(orders.map((o) => [o.id, map[o.id]]));
const DELIVERED = { status: 'Delivered', state: 'moved', at: '2026-06-07T10:00:00.000Z' };

test('named orders move to delivered on the courier\'s date, and a preview writes nothing', async () => {
  const rows = [{ id: 'a', razorpay_order_id: 'IC-A', status: 'out_for_delivery', shipped_at: '2026-06-01T00:00:00Z' }];
  const preview = fakeDb(rows);
  const p = await runSelected(preview, { orderIds: ['a'], dryRun: true, check: answers({ a: DELIVERED }), now: LATER });
  assert.equal(p.to_delivered, 1);
  assert.equal(preview.writes.length, 0);

  const real = fakeDb(rows);
  await runSelected(real, { orderIds: ['a'], check: answers({ a: DELIVERED }), now: LATER });
  assert.equal(real.writes[0].status, 'delivered');
  assert.equal(real.writes[0].delivered_at, '2026-06-07T10:00:00.000Z');
});

test('an old parcel the courier gives no date for stays undated', async () => {
  const db = fakeDb([{ id: 'a', status: 'out_for_delivery', shipped_at: '2026-06-01T00:00:00Z' }]);
  const r = await runSelected(db, { orderIds: ['a'], check: answers({ a: { status: 'Delivered', state: 'moved' } }), now: LATER });
  assert.equal(r.undated, 1);
  assert.equal('delivered_at' in db.writes[0], false);
});

test('orders where delivered would start a refund or a cancel flow are held for a person', async () => {
  const base = { status: 'out_for_delivery', shipped_at: '2026-06-01T00:00:00Z' };
  const rows = [
    { ...base, id: 'w', razorpay_order_id: 'W', wrong_cod_paise: 5000 },
    { ...base, id: 'l', razorpay_order_id: 'L', late_cancel_state: 'awaiting_return' },
    { ...base, id: 'c', razorpay_order_id: 'C', cancellation_requested_at: '2026-06-02T00:00:00Z' },
    { ...base, id: 'p', razorpay_order_id: 'P', wrong_cod_paise: 5000, wrong_cod_refund_at: '2026-06-09T00:00:00Z' },
  ];
  const db = fakeDb(rows);
  const r = await runSelected(db, { orderIds: ['w', 'l', 'c', 'p'], check: answers({ w: DELIVERED, l: DELIVERED, c: DELIVERED, p: DELIVERED }), now: LATER });
  assert.deepEqual(r.held.map((h) => h.why), ['wrong_cod_refund_pending', 'late_cancel', 'cancellation_requested']);
  assert.equal(r.to_delivered, 1, 'a wrong-COD refund already paid is not held');
  assert.equal(db.writes.length, 1);
});

test('a courier that does not say delivered changes nothing, not even the stored status', async () => {
  const db = fakeDb([
    { id: 'x', razorpay_order_id: 'X', status: 'out_for_delivery' },
    { id: 'y', razorpay_order_id: 'Y', status: 'out_for_delivery' },
  ]);
  const r = await runSelected(db, { orderIds: ['x', 'y'], check: answers({ x: { status: 'exception', state: 'moved' }, y: undefined }), now: LATER });
  assert.equal(db.writes.length, 0);
  assert.deepEqual(r.not_delivered.map((n) => n.order), ['X', 'Y']);
});
