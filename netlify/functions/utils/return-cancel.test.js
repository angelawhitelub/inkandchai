const test = require('node:test');
const assert = require('node:assert/strict');
const { cancelReturn, whyNotCancellable } = require('./return-cancel');

const NOW = Date.parse('2026-11-05T10:00:00Z');
const OLD = '2026-11-01T10:00:00Z';

function fakeDb(row, { failUpdate = '' } = {}) {
  const updates = [];
  return {
    row, updates,
    from() {
      let fields; const filters = {};
      const b = {
        update(f) { fields = f; return b; },
        eq(c, v) { filters[c] = v; return b; },
        select() {
          if (failUpdate) return Promise.resolve({ data: null, error: { message: failUpdate } });
          const hit = Object.entries(filters).every(([c, v]) => row[c] === v);
          if (hit) { Object.assign(row, fields); updates.push(fields); }
          return Promise.resolve({ data: hit ? [{ id: row.id }] : [], error: null });
        },
      };
      return b;
    },
  };
}

const ret = (over = {}) => ({
  id: 'r1', status: 'pickup_scheduled', awb: 'A1', courier_name: 'XpressBees', created_at: OLD,
  order_display_id: 'IC-1', refund_method: 'wallet', payment_type: 'cod',
  refund_status: 'awaiting_return_delivery', tracking_status: 'awaiting_pickup', tracking_last_scan: 'Data received',
  ...over,
});

function tracker(...stages) {
  const calls = [];
  const fn = async (awbs) => {
    const s = stages[Math.min(calls.length, stages.length - 1)];
    calls.push(awbs);
    return new Map(awbs.map((a) => [a, typeof s === 'string' ? { awb: a, source: 'xpressbees', stage: s, status: s } : s]));
  };
  fn.calls = calls;
  return fn;
}

function courier(result = { ok: true, message: 'XpressBees cancelled A1.' }) {
  const fn = async (order, live) => { fn.calls.push({ order, live }); return result; };
  fn.calls = [];
  return fn;
}

const deps = (extra) => ({ now: () => NOW, ...extra });

test('a pickup still waiting is voided at the courier and the refund is stopped', async () => {
  const db = fakeDb(ret());
  const cancelAtCourier = courier();
  const out = await cancelReturn(db, { ...db.row }, {}, deps({ trackReturns: tracker('awaiting_pickup', 'cancelled'), cancelAtCourier }));
  assert.equal(out.ok, true);
  assert.equal(out.courier_cancelled, true);
  assert.equal(cancelAtCourier.calls.length, 1);
  assert.equal(cancelAtCourier.calls[0].live.channel, 'xpressbees');
  assert.equal(cancelAtCourier.calls[0].order.tracking_id, 'A1');
  assert.equal(db.row.status, 'cancelled');
  assert.equal(db.row.refund_status, 'cancelled');
  assert.equal(db.row.tracking_status, 'cancelled');
  assert.match(out.message, /not been messaged/);
});

test('NimbusPost tracking routes the void to NimbusPost whatever the row is labelled', async () => {
  const db = fakeDb(ret());
  const cancelAtCourier = courier({ ok: true, message: 'NimbusPost cancelled A1.' });
  const view = { awb: 'A1', source: 'nimbuspost', stage: 'awaiting_pickup', status: 'booked' };
  await cancelReturn(db, { ...db.row }, {}, deps({ trackReturns: tracker(view), cancelAtCourier }));
  assert.equal(cancelAtCourier.calls[0].live.channel, 'nimbuspost');
});

for (const stage of ['picked_up', 'in_transit', 'out_for_delivery', 'delivered']) {
  test(`a parcel at "${stage}" is never cancelled, not even when forced`, async () => {
    for (const force of [false, true]) {
      const db = fakeDb(ret());
      const cancelAtCourier = courier();
      const out = await cancelReturn(db, { ...db.row }, { force }, deps({ trackReturns: tracker(stage), cancelAtCourier }));
      assert.equal(out.ok, false);
      assert.equal(out.can_force, undefined);
      assert.equal(cancelAtCourier.calls.length, 0);
      assert.equal(db.row.status, 'pickup_scheduled');
      assert.equal(db.row.refund_status, 'awaiting_return_delivery');
    }
  });
}

test('when the courier refuses, the row goes back exactly as it was', async () => {
  const db = fakeDb(ret());
  const cancelAtCourier = courier({ ok: false, message: 'XpressBees said no.' });
  const out = await cancelReturn(db, { ...db.row }, {}, deps({ trackReturns: tracker('awaiting_pickup'), cancelAtCourier }));
  assert.equal(out.ok, false);
  assert.equal(out.can_force, true);
  assert.match(out.message, /XpressBees said no/);
  assert.equal(db.row.status, 'pickup_scheduled');
  assert.equal(db.row.refund_status, 'awaiting_return_delivery');
  assert.equal(db.row.tracking_status, 'awaiting_pickup');
  assert.equal(db.row.tracking_last_scan, 'Data received');
});

test('a row we cannot write stops before the courier is touched', async () => {
  const db = fakeDb(ret(), { failUpdate: 'violates check constraint' });
  const cancelAtCourier = courier();
  const out = await cancelReturn(db, { ...db.row }, {}, deps({ trackReturns: tracker('awaiting_pickup'), cancelAtCourier }));
  assert.equal(out.ok, false);
  assert.equal(cancelAtCourier.calls.length, 0);
  assert.match(out.message, /courier was not contacted/);
});

test('no courier answering is not "waiting": refused, and only force closes it', async () => {
  const view = { awb: 'A1', source: '', stage: 'unknown', error: 'Record not found' };
  const db = fakeDb(ret());
  const cancelAtCourier = courier();
  const refused = await cancelReturn(db, { ...db.row }, {}, deps({ trackReturns: tracker(view), cancelAtCourier }));
  assert.equal(refused.ok, false);
  assert.equal(refused.can_force, true);
  assert.equal(db.row.status, 'pickup_scheduled');

  const forced = await cancelReturn(db, { ...db.row }, { force: true }, deps({ trackReturns: tracker(view), cancelAtCourier }));
  assert.equal(forced.ok, true);
  assert.equal(forced.courier_cancelled, false);
  assert.match(forced.message, /NOT cancelled with the courier/);
  assert.equal(cancelAtCourier.calls.length, 0);
  assert.equal(db.row.status, 'cancelled');
});

test('tracking that throws is treated as unknown, not as waiting', async () => {
  const db = fakeDb(ret());
  const cancelAtCourier = courier();
  const out = await cancelReturn(db, { ...db.row }, {}, deps({ trackReturns: async () => { throw new Error('down'); }, cancelAtCourier }));
  assert.equal(out.ok, false);
  assert.equal(cancelAtCourier.calls.length, 0);
});

test('an AWB the courier already voided just closes the row', async () => {
  const db = fakeDb(ret());
  const cancelAtCourier = courier();
  const out = await cancelReturn(db, { ...db.row }, {}, deps({ trackReturns: tracker('cancelled'), cancelAtCourier }));
  assert.equal(out.ok, true);
  assert.equal(cancelAtCourier.calls.length, 0);
  assert.equal(db.row.status, 'cancelled');
});

test('no AWB closes without a courier; a queued NimbusPost order is pointed out', async () => {
  const db = fakeDb(ret({ awb: null, status: 'pushed_to_nimbus', order_display_id: 'IC-20261031-PT415' }));
  const track = tracker('awaiting_pickup');
  const out = await cancelReturn(db, { ...db.row }, {}, deps({ trackReturns: track }));
  assert.equal(out.ok, true);
  assert.equal(track.calls.length, 0);
  assert.match(out.message, /R-RET-20261031-PT415/);
  assert.equal(db.row.status, 'cancelled');
  assert.equal(db.row.tracking_status, 'awaiting_pickup');
});

test('money already moving, or books already back, refuses', () => {
  for (const over of [
    { refund_status: 'wallet_issued' }, { refund_status: 'refunded' }, { refund_status: 'refunding' },
    { refund_status: 'manual_refund_pending' }, { refunded_at: OLD }, { return_delivered_at: OLD },
    { status: 'cancelled' }, { status: 'rejected' },
  ]) {
    assert.ok(whyNotCancellable(ret(over), NOW), JSON.stringify(over));
  }
  assert.equal(whyNotCancellable(ret(), NOW), '');
  assert.equal(whyNotCancellable(ret({ refund_status: 'manual_payout_pending' }), NOW), '');
});

test('a return still being booked waits, so the booking cannot overwrite the cancel', () => {
  const fresh = ret({ status: 'approved', awb: null, created_at: new Date(NOW - 60 * 1000).toISOString() });
  assert.match(whyNotCancellable(fresh, NOW), /still being booked/);
  assert.equal(whyNotCancellable({ ...fresh, created_at: OLD }, NOW), '');
});
