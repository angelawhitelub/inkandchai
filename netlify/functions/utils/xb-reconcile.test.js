const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, applyOne, fromXb, fromNp } = require('../admin-xb-reconcile')._test;

const ship = (awb, order_number, ship_status = 'booked') => fromXb({ awb_number: awb, order_number, ship_status });
const order = (id, extra = {}) => ({ id: 'u-' + id, razorpay_order_id: id, status: 'shipped', tracking_id: null, ...extra });

test('every live XpressBees shipment is sorted against our order', () => {
  const o = {
    ok: order('IC-OK', { tracking_id: 'A1' }),
    stale: order('IC-STALE', { tracking_id: 'A2', status: 'paid' }),
    missing: order('IC-MISS', { status: 'cod_pending' }),
    other: order('IC-OTHER', { tracking_id: 'EK9', courier_name: 'Ekart', status: 'shipped' }),
    closed: order('IC-CLOSED', { status: 'cancelled' }),
  };
  const byAwb = new Map([['A1', o.ok], ['A2', o.stale]]);
  const byNumber = new Map([['IC-MISS', o.missing], ['IC-OTHER', o.other], ['IC-CLOSED', o.closed]]);
  const rows = classify([
    ship('A1', 'IC-OK'), ship('A2', 'IC-STALE'), ship('A3', 'IC-MISS-c1'), ship('A4', 'IC-OTHER'),
    ship('A5', 'IC-CLOSED'), ship('A6', 'IC-NOPE'), ship('A7', 'IC-OK', 'Cancelled'),
  ], byAwb, byNumber);
  assert.deepEqual(rows.map((r) => [r.awb, r.kind]), [
    ['A1', 'ok'], ['A2', 'status_stale'], ['A3', 'awb_missing'], ['A4', 'other_awb'],
    ['A5', 'order_closed'], ['A6', 'not_found'],
  ]);
});

test('a fix sets AWB + shipped only while the order is still unshipped, and tells a customer never told', async () => {
  const calls = [];
  const q = {
    update(p) { calls.push(['update', p]); return q; }, eq(c, v) { calls.push(['eq', c, v]); return q; },
    in(c, v) { calls.push(['in', c, v]); return q; }, is(c, v) { calls.push(['is', c, v]); return q; },
    select: async () => ({ data: [{ id: 'u-IC-MISS' }], error: null }),
  };
  const supabase = { from: () => q };
  const sent = [];
  const row = { kind: 'awb_missing', awb: 'A3', notify: true, _order: order('IC-MISS', { status: 'cod_pending' }) };
  const out = await applyOne(supabase, row, { sendShippedNotification: async (o, a) => { sent.push([o.razorpay_order_id, a.awb]); return { ok: true }; } });
  assert.equal(out.ok, true);
  assert.deepEqual(sent, [['IC-MISS', 'A3']]);
  const patch = calls.find((c) => c[0] === 'update')[1];
  assert.equal(patch.status, 'shipped');
  assert.equal(patch.tracking_id, 'A3');
  assert.ok(calls.some((c) => c[0] === 'in' && c[1] === 'status'));
  assert.ok(calls.some((c) => c[0] === 'is' && c[1] === 'tracking_id' && c[2] === null));
});

test('the check never cancels or books at XpressBees', () => {
  const src = require('fs').readFileSync(require('path').resolve(__dirname, '../admin-xb-reconcile.js'), 'utf8');
  assert.doesNotMatch(src, /cancelCourierShipment|xb\.cancel|createShipment|\/ship\/assets\/label|from\([^)]*\)\.delete\(/);
});

test('a NimbusPost booking (DTDC via NimbusPost) next to an XpressBees AWB shows as booked twice', () => {
  const np = fromNp({ order_id: 'np1', order_number: 'IC-20261104-Y3KMW-c', status_tab: 'ready_to_ship', shipment: { awb: '7D130602252', courier_name: 'DTDC Surface' } });
  assert.equal(np.source, 'NimbusPost');
  assert.equal(np.courier, 'DTDC Surface');
  const ours = order('IC-20261104-Y3KMW', { tracking_id: '143449611656930', courier_name: 'XpressBees' });
  const rows = classify([np], new Map(), new Map([['IC-20261104-Y3KMW', ours]]));
  assert.equal(rows[0].kind, 'other_awb');
  assert.equal(rows[0].order_id, 'IC-20261104-Y3KMW');
});
