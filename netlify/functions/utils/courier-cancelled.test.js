const test = require('node:test');
const assert = require('node:assert/strict');
const { courierSaysCancelled, handleCourierCancelled } = require('./courier-cancelled');

const DAY = 86400000;
const NOW = new Date('2026-09-28T12:00:00Z').getTime();
const AWB = '143449610819605';

// One orders row; updates apply only when every condition matches, like Postgres.
function fakeDb(row, { missingColumn = false } = {}) {
  const db = { row: { ...row }, updates: [] };
  db.from = () => {
    const q = { conds: [] };
    const match = () => q.conds.every(([op, col, val]) => {
      if (op === 'eq') return String(db.row[col]) === String(val);
      if (op === 'in') return val.includes(db.row[col]);
      if (op === 'is') return db.row[col] == val;
      return true;
    });
    const run = () => {
      if (!q.update) return { data: match() ? db.row : null, error: null };
      if (missingColumn && 'courier_cancelled_at' in q.update) {
        return { data: null, error: { message: 'column orders.courier_cancelled_at does not exist' } };
      }
      if (!match()) return { data: [], error: null };
      Object.assign(db.row, q.update);
      db.updates.push(q.update);
      return { data: [{ id: db.row.id }], error: null };
    };
    const b = {
      select() { return b; },
      update(u) { q.update = u; return b; },
      eq(c, v) { q.conds.push(['eq', c, v]); return b; },
      in(c, v) { q.conds.push(['in', c, v]); return b; },
      is(c, v) { q.conds.push(['is', c, v]); return b; },
      maybeSingle() { return Promise.resolve(run()); },
      then(ok, bad) { return Promise.resolve(run()).then(ok, bad); },
    };
    return b;
  };
  return db;
}

const order = (over = {}) => ({
  id: 'u1',
  razorpay_order_id: 'IC-20260910-ABCDE',
  razorpay_payment_id: 'T2609101234',
  amount_paise: 59900,
  status: 'shipped',
  courier_name: 'Xpressbees',
  tracking_id: AWB,
  created_at: new Date(NOW - 18 * DAY).toISOString(),
  shipment_moved_at: null,
  source: 'website',
  ...over,
});

function deps(liveStatus = 'cancelled') {
  const d = { emails: [], notified: [], tracked: 0 };
  d.sendEmail = async (m) => { d.emails.push(m); return { ok: true }; };
  d.notify = async (o, opts) => { d.notified.push({ o, opts }); return { email: true, whatsapp: true, refund: { ok: true, provider: 'phonepe', nextStatus: 'refund_pending' } }; };
  d.track = async () => { d.tracked += 1; return { status: liveStatus }; };
  return d;
}

process.env.STORE_OWNER_EMAIL = 'owner@example.com';
delete process.env.COURIER_CANCEL_GRACE_HOURS;

test('only XpressBees\' own "cancelled" counts', () => {
  for (const s of ['cancelled', 'Cancelled', 'Shipment Canceled']) assert.equal(courierSaysCancelled(s), true, s);
  for (const s of ['cancellation requested', 'rto cancelled', 'in transit', '', null, 'pending pickup']) assert.equal(courierSaysCancelled(s), false, String(s));
});

test('first sighting only stamps and warns the owner — no cancel, no refund', async () => {
  const db = fakeDb(order());
  const d = deps();
  const r = await handleCourierCancelled(db, 'u1', { awb: AWB, now: NOW }, d);
  assert.equal(r.action, 'seen');
  assert.equal(db.row.status, 'shipped');
  assert.equal(db.row.courier_cancelled_awb, AWB);
  assert.equal(d.notified.length, 0);
  assert.equal(d.emails.length, 1);
  assert.match(d.emails[0].subject, /XpressBees cancelled shipment/);
});

test('inside the grace period it waits', async () => {
  const db = fakeDb(order({ courier_cancelled_at: new Date(NOW - 2 * 3600000).toISOString(), courier_cancelled_awb: AWB }));
  const d = deps();
  const r = await handleCourierCancelled(db, 'u1', { awb: AWB, now: NOW }, d);
  assert.equal(r.action, 'waiting');
  assert.equal(db.row.status, 'shipped');
  assert.equal(d.notified.length, 0);
});

test('after the grace period: re-checks live, cancels once and refunds through the chokepoint', async () => {
  const db = fakeDb(order({ courier_cancelled_at: new Date(NOW - 7 * 3600000).toISOString(), courier_cancelled_awb: AWB }));
  const d = deps();
  const r = await handleCourierCancelled(db, 'u1', { awb: AWB, now: NOW }, d);
  assert.equal(r.action, 'cancelled');
  assert.equal(d.tracked, 1);
  assert.equal(db.row.status, 'cancelled');
  assert.equal(db.row.cancellation_source, 'courier_xpressbees');
  assert.equal(d.notified.length, 1);
  assert.equal(d.notified[0].opts.kind, 'store');
  assert.ok(d.emails.some(e => /cancelled — XpressBees cancelled AWB/.test(e.subject)));

  // A second event (webhook + poll) finds it already cancelled.
  const again = await handleCourierCancelled(db, 'u1', { awb: AWB, now: NOW }, d);
  assert.equal(again.action, 'ignored');
  assert.equal(d.notified.length, 1);
});

test('XpressBees no longer saying cancelled on the live re-check stops it', async () => {
  const db = fakeDb(order({ courier_cancelled_at: new Date(NOW - 7 * 3600000).toISOString(), courier_cancelled_awb: AWB }));
  const d = deps('in transit');
  const r = await handleCourierCancelled(db, 'u1', { awb: AWB, now: NOW }, d);
  assert.equal(r.action, 'ignored');
  assert.equal(db.row.status, 'shipped');
  assert.equal(d.notified.length, 0);
});

test('a re-booked order (new AWB) is untouched by the old cancellation', async () => {
  const db = fakeDb(order({ tracking_id: '143449610999999', courier_cancelled_at: new Date(NOW - 9 * 3600000).toISOString(), courier_cancelled_awb: AWB }));
  const d = deps();
  const r = await handleCourierCancelled(db, 'u1', { awb: AWB, now: NOW }, d);
  assert.equal(r.action, 'ignored');
  assert.equal(db.row.status, 'shipped');
});

test('a sighting for an earlier AWB does not let the new one skip its grace period', async () => {
  const db = fakeDb(order({ courier_cancelled_at: new Date(NOW - 30 * 3600000).toISOString(), courier_cancelled_awb: '143449610000001' }));
  const d = deps();
  const r = await handleCourierCancelled(db, 'u1', { awb: AWB, now: NOW }, d);
  assert.equal(r.action, 'seen');
  assert.equal(db.row.status, 'shipped');
});

test('younger than 10 days, moved parcels and replacements are held for a person', async () => {
  const stamp = { courier_cancelled_at: new Date(NOW - 7 * 3600000).toISOString(), courier_cancelled_awb: AWB };
  for (const over of [
    { created_at: new Date(NOW - 4 * DAY).toISOString() },
    { shipment_moved_at: new Date(NOW - 3 * DAY).toISOString() },
    { source: 'replacement', razorpay_order_id: 'IC-R-20260910-ZZZZZ', amount_paise: 0, razorpay_payment_id: null },
  ]) {
    const db = fakeDb(order({ ...stamp, ...over }));
    const d = deps();
    const r = await handleCourierCancelled(db, 'u1', { awb: AWB, now: NOW }, d);
    assert.equal(r.action, 'held', JSON.stringify(over));
    assert.equal(db.row.status, 'shipped');
    assert.equal(d.notified.length, 0);
  }
});

test('other couriers, delivered and refund states are never touched', async () => {
  for (const over of [{ courier_name: 'Delhivery' }, { status: 'delivered' }, { status: 'refund_pending' }, { status: 'out_for_delivery' }]) {
    const db = fakeDb(order({ courier_cancelled_at: new Date(NOW - 9 * 3600000).toISOString(), courier_cancelled_awb: AWB, ...over }));
    const d = deps();
    const r = await handleCourierCancelled(db, 'u1', { awb: AWB, now: NOW }, d);
    assert.equal(r.action, 'ignored', JSON.stringify(over));
    assert.equal(d.notified.length, 0);
  }
});

test('without the migration nothing is ever cancelled', async () => {
  const db = fakeDb(order(), { missingColumn: true });
  const d = deps();
  const r = await handleCourierCancelled(db, 'u1', { awb: AWB, now: NOW }, d);
  assert.equal(r.action, 'error');
  assert.match(r.reason, /orders_courier_cancelled_at\.sql/);
  assert.equal(db.row.status, 'shipped');
});

test('dry run reports what it would do and writes nothing', async () => {
  const db = fakeDb(order({ courier_cancelled_at: new Date(NOW - 7 * 3600000).toISOString(), courier_cancelled_awb: AWB }));
  const d = deps();
  const r = await handleCourierCancelled(db, 'u1', { awb: AWB, now: NOW, dryRun: true, liveChecked: true }, d);
  assert.equal(r.action, 'would_cancel');
  assert.equal(db.row.status, 'shipped');
  assert.equal(db.updates.length, 0);
});
