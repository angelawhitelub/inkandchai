'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  collectRows, rowSeq, reshipPatch, appendPreviousAwb, updateOrderTolerant,
  RESHIPPABLE_STATUSES, REVIEW_ONLY_STATUSES,
} = require('../../netlify/functions/nimbuspost-awb-sync-background')._test;

test('the newest shipment wins when an order has been re-shipped', () => {
  const map = new Map();
  // Deliberately out of order: the cancelled first shipment arrives last.
  collectRows({ data: [
    { id: 900, order_number: 'IC-20260825-5TUYC', awb_number: 'NEW999', courier_name: 'Delhivery' },
    { id: 100, order_number: 'IC-20260825-5TUYC', awb_number: 'OLD111', courier_name: 'DTDC' },
  ] }, map);
  assert.strictEqual(map.get('IC-20260825-5TUYC').awb, 'NEW999');

  const map2 = new Map();
  collectRows({ data: [
    { id: 100, order_number: 'IC-1', awb_number: 'OLD111' },
    { id: 900, order_number: 'IC-1', awb_number: 'NEW999' },
  ] }, map2);
  assert.strictEqual(map2.get('IC-1').awb, 'NEW999', 'must not depend on feed order');
});

test('rows with no usable id still collect rather than being dropped', () => {
  const map = new Map();
  collectRows({ data: [{ order_number: 'IC-2', awb_number: 'A1' }] }, map);
  assert.strictEqual(map.get('IC-2').awb, 'A1');
  assert.strictEqual(rowSeq({}), 0);
  assert.strictEqual(rowSeq({ id: '42' }), 42);
  assert.strictEqual(rowSeq({ id: 'abc' }), 0);
});

test('a re-ship clears every stamp that described the dead shipment', () => {
  const order = {
    status: 'cancelled',
    tracking_id: 'OLD111',
    last_nimbuspost_status: 'cancelled',
    last_nimbuspost_event_at: '2026-08-30T00:00:00Z',
    shipment_moved_at: '2026-08-29T00:00:00Z',
    in_transit_notified_at: '2026-08-29T00:00:00Z',
    cancelled_at: '2026-08-30T00:00:00Z',
    cancellation_source: 'nimbuspost',
    nimbuspost_auto_cancelled: true,
  };
  const p = reshipPatch(order, { awb: 'NEW999', courier: 'Delhivery' }, '2026-09-03T00:00:00Z');
  assert.strictEqual(p.status, 'shipped');
  assert.strictEqual(p.tracking_id, 'NEW999');
  assert.match(p.tracking_url, /NEW999$/);
  for (const k of ['last_nimbuspost_status', 'last_nimbuspost_event_at', 'shipment_moved_at',
                   'in_transit_notified_at', 'cancelled_at', 'cancellation_source',
                   'cancellation_reason', 'auto_cancelled_at']) {
    assert.strictEqual(p[k], null, `${k} must be cleared`);
  }
  assert.strictEqual(p.nimbuspost_auto_cancelled, false);
  // Without this the auto-cancel job would cancel the fresh shipment again.
  assert.strictEqual(p.previous_tracking_ids, 'OLD111');
});

test('the courier name is kept when the new row does not carry one', () => {
  const p = reshipPatch({ tracking_id: 'OLD', courier_name: 'DTDC' }, { awb: 'NEW' }, 'now');
  assert.strictEqual(p.courier_name, 'DTDC');
});

test('the AWB history accumulates and never duplicates', () => {
  assert.strictEqual(appendPreviousAwb('', 'A1'), 'A1');
  assert.strictEqual(appendPreviousAwb('A1', 'A2'), 'A1,A2');
  assert.strictEqual(appendPreviousAwb('A1,A2', 'A1'), 'A1,A2');
  assert.strictEqual(appendPreviousAwb(null, null), '');
  assert.ok(appendPreviousAwb('X'.repeat(600), 'A1').length <= 500);
});

test('settled orders are never re-shipped automatically', () => {
  // The whole hazard: 34 of 53 courier-cancelled orders were already refunded.
  for (const s of ['refunded', 'partially_refunded', 'refund_pending', 'refund_failed']) {
    assert.ok(REVIEW_ONLY_STATUSES.includes(s), s);
    assert.ok(!RESHIPPABLE_STATUSES.includes(s), s);
  }
  // A new AWB on a finished shipment is a return leg, not a re-ship.
  for (const s of ['delivered', 'rto', 'lost', 'undelivered']) {
    assert.ok(REVIEW_ONLY_STATUSES.includes(s), s);
    assert.ok(!RESHIPPABLE_STATUSES.includes(s), s);
  }
  // The case this was built for.
  assert.ok(RESHIPPABLE_STATUSES.includes('cancelled'));
  assert.ok(RESHIPPABLE_STATUSES.includes('shipped'));
});

test('the two status lists never overlap', () => {
  const both = RESHIPPABLE_STATUSES.filter(s => REVIEW_ONLY_STATUSES.includes(s));
  assert.deepStrictEqual(both, [], 'a status cannot be both actionable and review-only');
});

test('a missing optional column drops that field and still writes the rest', () => {
  const calls = [];
  const db = {
    from: () => ({
      update(fields) {
        calls.push({ ...fields });
        return {
          eq: () => ({
            select: async () => ('previous_tracking_ids' in fields)
              ? { error: { message: 'column orders.previous_tracking_ids does not exist' } }
              : { data: [{ id: 'o1' }], error: null },
          }),
        };
      },
    }),
  };
  return updateOrderTolerant(db, 'o1', { status: 'shipped', tracking_id: 'NEW', previous_tracking_ids: 'OLD' })
    .then(r => {
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(calls[calls.length - 1], { status: 'shipped', tracking_id: 'NEW' });
    });
});

test('an update matching no row is an error, not a silent success', async () => {
  const db = { from: () => ({ update: () => ({ eq: () => ({ select: async () => ({ data: [], error: null }) }) }) }) };
  const r = await updateOrderTolerant(db, 'missing', { status: 'shipped' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /matched no order row/);
});

const { rowCreated, reshipIsRecent } = require('../../netlify/functions/nimbuspost-awb-sync-background')._test;

test('a stale re-ship corrects tracking without a fresh shipped message', () => {
  const now = Date.parse('2026-09-03T12:00:00Z');
  assert.ok(reshipIsRecent('2026-09-03', now));
  assert.ok(reshipIsRecent('2026-08-28', now));
  // Three weeks late: the customer probably has the book already.
  assert.ok(!reshipIsRecent('2026-08-12', now));
});

test('an unreadable panel date is treated as current, never as ancient', () => {
  const now = Date.parse('2026-09-03T12:00:00Z');
  for (const v of ['', null, undefined, 'soon', '03/09/2026']) assert.ok(reshipIsRecent(v, now), String(v));
  assert.strictEqual(rowCreated({ created: '2026-09-03' }), '2026-09-03');
  assert.strictEqual(rowCreated({ created: '03-09-2026' }), '');
  assert.strictEqual(rowCreated({}), '');
});

test('the shipment creation date is carried through the map', () => {
  const map = new Map();
  collectRows({ data: [{ id: 9, order_number: 'IC-3', awb_number: 'A', created: '2026-09-03' }] }, map);
  assert.strictEqual(map.get('IC-3').created, '2026-09-03');
});
