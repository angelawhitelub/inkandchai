'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rto = require('./rto-refund');
const { runAutoRefund, CLAIM } = require('../rto-auto-refund-scheduled');

// ── fixtures ────────────────────────────────────────────────────────────────

const book = (title) => ({ title, qty: 1 });

function order(over = {}) {
  return {
    id: over.id || 'uuid-' + (over.razorpay_order_id || 'IC-1'),
    razorpay_order_id: 'IC-1',
    razorpay_payment_id: 'OMO123',
    amount_paise: 49900,
    status: 'rto',
    created_at: new Date(Date.now() - 10 * 86400000).toISOString(),
    customer_name: 'A',
    cart_items: [book('Some Book')],
    tracking_id: '143449610549540',
    courier_name: 'Xpressbees',
    refund_id: null,
    refund_state: null,
    ...over,
  };
}

/** Enough of supabase-js for the job: select with eq/is/gte/contains, and update. */
function fakeSupabase(orders, replacements = []) {
  const rows = orders.map(o => ({ ...o }));
  const updates = [];
  function builder(table) {
    const q = { op: 'select', filters: [], payload: null, contains: null };
    const match = (r) => q.filters.every(([col, kind, val]) =>
      kind === 'eq' ? r[col] === val : kind === 'is' ? (r[col] ?? null) === val : kind === 'gte' ? String(r[col]) >= val : true);
    const run = () => {
      if (q.contains) {
        assert.equal(typeof q.contains, 'string', 'jsonb containment must be sent as JSON');
        const want = JSON.parse(q.contains)[0]._replacement.original_order_id;
        return { data: replacements.filter(r => r.original === want).map(r => ({ razorpay_order_id: r.id, status: r.status || 'shipped' })), error: null };
      }
      if (q.op === 'update') {
        const hit = rows.filter(match);
        hit.forEach(r => Object.assign(r, q.payload));
        updates.push({ payload: q.payload, ids: hit.map(r => r.id) });
        return { data: hit.map(r => ({ id: r.id })), error: null };
      }
      return { data: rows.filter(match).map(r => ({ ...r })), error: null };
    };
    const api = {
      select() { return api; },
      eq(c, v) { q.filters.push([c, 'eq', v]); return api; },
      is(c, v) { q.filters.push([c, 'is', v]); return api; },
      gte(c, v) { q.filters.push([c, 'gte', v]); return api; },
      contains(_c, v) { q.contains = v; return api; },
      order() { return api; },
      range() { return api; },
      limit() { return api; },
      update(p) { q.op = 'update'; q.payload = p; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }
  return { from: builder, rows, updates };
}

const XB_BACK = { awb_number: '143449610549540', status: 'rto', history: [
  { status_code: 'RT-IT', message: 'RTO Out For Delivery', event_time: '2026-09-24 10:29' },
  { status_code: 'RT-DL', message: 'RTO Delivered', event_time: '2026-09-24 15:30' },
] };
const XB_ON_WAY = { awb_number: '143449610543700', status: 'rto', history: [
  { status_code: 'RT-IT', message: 'Reached At Origin', event_time: '2026-09-30 13:28' },
] };

function refundSpy(reply = { statusCode: 200, body: JSON.stringify({ success: true, state: 'COMPLETED', message: 'ok' }) }) {
  const calls = [];
  const fn = async (gateway, id, paise) => { calls.push({ gateway, id, paise }); return typeof reply === 'function' ? reply(id) : reply; };
  fn.calls = calls;
  return fn;
}

const noAlert = async () => {};

// ── the verification rules ──────────────────────────────────────────────────

test('XpressBees: only the RT-DL scan counts as back with us', () => {
  assert.equal(rto.xbReturnedToOrigin(XB_BACK, '143449610549540').verified, true);
  const onWay = rto.xbReturnedToOrigin(XB_ON_WAY, '143449610543700');
  assert.equal(onWay.verified, false);
  assert.match(onWay.reason, /Reached At Origin/);
  // A payload for some other AWB is never accepted.
  assert.equal(rto.xbReturnedToOrigin(XB_BACK, '143449610000000').verified, false);
  assert.equal(rto.xbReturnedToOrigin(null, 'x').verified, false);
});

test('NimbusPost: rto delivered on the exact AWB, nothing looser', () => {
  assert.equal(rto.npReturnedToOrigin({ awb_number: '236454', status: 'rto delivered' }, '236454').verified, true);
  assert.equal(rto.npReturnedToOrigin({ awb_number: '236454', status: 'RTO Delivered' }, '236454').verified, true);
  assert.equal(rto.npReturnedToOrigin({ awb_number: '236454', status: 'rto in transit' }, '236454').verified, false);
  assert.equal(rto.npReturnedToOrigin({ awb_number: '236454', status: 'delivered' }, '236454').verified, false);
  assert.equal(rto.npReturnedToOrigin({ awb_number: '999', status: 'rto delivered' }, '236454').verified, false);
  assert.equal(rto.npReturnedToOrigin(undefined, '236454').verified, false);
  // Headline "rto", delivered-back scan only in the history message.
  const hist = { awb_number: '236454', status: 'rto', history: [
    { status_code: 'RT', status: 'rto', message: 'RTO Delivered', event_time: '2026-09-20 11:00' }] };
  assert.equal(rto.npReturnedToOrigin(hist, '236454').verified, true);
  const onWay = { awb_number: '236454', status: 'rto', history: [
    { status_code: 'RT', status: 'rto', message: 'RTO In Transit', event_time: '2026-09-20 11:00' }] };
  assert.match(rto.npReturnedToOrigin(onWay, '236454').reason, /RTO In Transit/);
});

test('courier routing: our XpressBees account direct, everything else NimbusPost', () => {
  assert.equal(rto.courierFor('143449610549540'), 'xpressbees');
  assert.equal(rto.courierFor('143459610549540'), 'xpressbees');
  assert.equal(rto.courierFor('142279610549540'), 'nimbuspost');
  assert.equal(rto.courierFor('23645410035012'), 'nimbuspost');
});

test('refund = paid minus both legs, heavier for a bundle', () => {
  const rates = { standard: 12400, heavy: 24800 };
  assert.equal(rto.rtoRefundFor(order(), { rates }).refund, 49900 - 12400);
  const bundle = rto.rtoRefundFor(order({ cart_items: [book('Book A + Book B')] }), { rates });
  assert.equal(bundle.deduction, 24800);
  assert.equal(rto.rtoRefundFor(order({ razorpay_payment_id: '' }), { rates }).gateway, null);
});

// ── the job ─────────────────────────────────────────────────────────────────

test('refunds a verified prepaid RTO once, for the calculated amount', async () => {
  const supabase = fakeSupabase([order()]);
  const refund = refundSpy();
  const s = await runAutoRefund({ supabase, refund, ownerAlert: noAlert, xbTrack: async () => XB_BACK, npTrackMany: async () => new Map() },
    { rates: { standard: 12400, heavy: 24800 } });
  assert.equal(s.refunded.length, 1);
  assert.deepEqual(refund.calls, [{ gateway: 'phonepe', id: 'IC-1', paise: 37500 }]);
  // Claimed before the gateway call.
  assert.equal(supabase.updates[0].payload.refund_state, CLAIM);
});

test('a parcel still on its way back is not refunded', async () => {
  const supabase = fakeSupabase([order({ tracking_id: '143449610543700' })]);
  const refund = refundSpy();
  const s = await runAutoRefund({ supabase, refund, ownerAlert: noAlert, xbTrack: async () => XB_ON_WAY, npTrackMany: async () => new Map() }, {});
  assert.equal(refund.calls.length, 0);
  assert.equal(s.waiting.length, 1);
  assert.equal(supabase.updates.length, 0);
});

test('a tracking failure never pays', async () => {
  const supabase = fakeSupabase([order(), order({ razorpay_order_id: 'IC-2', id: 'u2', tracking_id: '236454100350120' })]);
  const refund = refundSpy();
  const s = await runAutoRefund({
    supabase, refund, ownerAlert: noAlert,
    xbTrack: async () => { throw new Error('502'); },
    npTrackMany: async () => { throw new Error('NimbusPost login failed'); },
  }, {});
  assert.equal(refund.calls.length, 0);
  assert.equal(s.waiting.length, 2);
});

test('COD, already-started and nothing-left orders are never touched', async () => {
  const supabase = fakeSupabase([
    order({ razorpay_order_id: 'COD', id: 'c', razorpay_payment_id: null }),
    order({ razorpay_order_id: 'CLAIMED', id: 'd', refund_state: CLAIM }),
    order({ razorpay_order_id: 'CHEAP', id: 'e', amount_paise: 9900 }),
  ]);
  const refund = refundSpy();
  await runAutoRefund({ supabase, refund, ownerAlert: noAlert, xbTrack: async () => XB_BACK, npTrackMany: async () => new Map() },
    { rates: { standard: 12400, heavy: 24800 } });
  assert.equal(refund.calls.length, 0);
});

test('an order that got a free replacement is not refunded', async () => {
  const supabase = fakeSupabase([order()], [{ id: 'IC-R-1', original: 'IC-1' }]);
  const refund = refundSpy();
  const s = await runAutoRefund({ supabase, refund, ownerAlert: noAlert, xbTrack: async () => XB_BACK, npTrackMany: async () => new Map() }, {});
  assert.equal(refund.calls.length, 0);
  assert.match(s.skipped[0].reason, /replacement/);
});

test('a dry run (the admin preview) reports but never claims or pays', async () => {
  const supabase = fakeSupabase([order()]);
  const refund = refundSpy();
  const s = await runAutoRefund({ supabase, refund, ownerAlert: noAlert, xbTrack: async () => XB_BACK, npTrackMany: async () => new Map() }, { dryRun: true });
  assert.equal(s.would_refund.length, 1);
  assert.equal(refund.calls.length, 0);
  assert.equal(supabase.updates.length, 0);
});

test('a refused refund releases the claim; the per-run cap holds', async () => {
  const many = [1, 2, 3].map(i => order({ razorpay_order_id: `IC-${i}`, id: `u${i}` }));
  const supabase = fakeSupabase(many);
  const refund = refundSpy((id) => id === 'IC-1'
    ? { statusCode: 400, body: JSON.stringify({ error: 'nope' }) }
    : { statusCode: 200, body: JSON.stringify({ success: true, state: 'PENDING' }) });
  const s = await runAutoRefund({ supabase, refund, ownerAlert: noAlert, xbTrack: async () => XB_BACK, npTrackMany: async () => new Map() }, { maxPerRun: 2 });
  assert.equal(s.failed.length, 1);
  assert.equal(s.refunded.length, 1);
  assert.equal(refund.calls.length, 2);
  assert.equal(supabase.rows.find(r => r.razorpay_order_id === 'IC-1').refund_state, null, 'claim released');
  assert.match(s.skipped.at(-1).reason, /cap/);
});

test('the job is owner-only over HTTP and never pays from there', async () => {
  process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-secret';
  const { handler } = require('../rto-auto-refund-scheduled');
  const res = await handler({ rawUrl: 'https://x/.netlify/functions/rto-auto-refund-scheduled', httpMethod: 'POST', headers: {}, path: '/.netlify/functions/rto-auto-refund-scheduled' });
  assert.equal(res.statusCode, 401);
});

test('manual refund endpoints refuse an order the job has claimed', async () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'phonepe-refund.js'), 'utf8')
    + require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'razorpay-refund.js'), 'utf8');
  assert.equal((src.match(/order\.refund_state === 'AUTO_CLAIMED' && body\.auto_rto !== true/g) || []).length, 2);
});
