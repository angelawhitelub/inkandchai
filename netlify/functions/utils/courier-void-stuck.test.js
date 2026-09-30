'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runVoid } = require('../courier-void-stuck');

const NOW = Date.parse('2026-10-01T00:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

function order(over = {}) {
  return { id: 'row-' + (over.razorpay_order_id || 'IC-1'), razorpay_order_id: 'IC-1', status: 'shipped',
    courier_name: 'XpressBees', tracking_id: '1434496100001', created_at: daysAgo(12),
    razorpay_payment_id: 'OMO1', amount_paise: 28900, nimbus_pushed_at: null, ...over };
}

function deps(rows, over = {}) {
  const calls = { cancelCourier: [], cancelNimbus: [], cancelOrder: [], markCancelled: [] };
  const byId = Object.fromEntries(rows.map(r => [r.razorpay_order_id, r]));
  const supabase = { from: () => {
    const q = { id: null };
    q.select = () => q;
    q.eq = (_c, v) => { q.id = v; return q; };
    q.maybeSingle = async () => ({ data: byId[q.id] || null, error: null });
    return q;
  } };
  return {
    calls,
    supabase, now: NOW,
    xbTrack: async () => ({ status: 'pending pickup' }),
    cancelCourier: async (o) => { calls.cancelCourier.push(o.razorpay_order_id); return { action: 'cancelled' }; },
    recordCancel: async () => {},
    cancelNimbus: async (n) => { calls.cancelNimbus.push(n); return { ok: true }; },
    cancelOrder: async (o) => { calls.cancelOrder.push(o.razorpay_order_id); return { statusCode: 200, data: { success: true } }; },
    markCancelled: async (_sb, id) => { calls.markCancelled.push(id); return { action: 'seen' }; },
    ...over,
  };
}

test('a dry run reads live statuses and changes nothing', async () => {
  const d = deps([order()]);
  const out = await runVoid(d, ['IC-1']);
  assert.equal(out.results[0].outcome, 'would_void');
  assert.equal(out.results[0].plan, 'cancel_and_refund_now');
  assert.deepEqual([d.calls.cancelCourier, d.calls.cancelOrder, d.calls.markCancelled], [[], [], []]);
});

test('an old order is voided at both couriers, then cancelled through the admin cancel', async () => {
  const d = deps([order({ nimbus_pushed_at: daysAgo(11) })]);
  const out = await runVoid(d, ['IC-1'], { dryRun: false });
  assert.equal(out.results[0].outcome, 'cancelled');
  assert.equal(out.results[0].nimbus, 'cancelled');
  assert.deepEqual(d.calls.cancelOrder, ['IC-1']);
  assert.equal(d.calls.markCancelled.length, 0);
});

test('a young order is voided and left to the automation, not cancelled', async () => {
  const d = deps([order({ created_at: daysAgo(8) })]);
  const out = await runVoid(d, ['IC-1'], { dryRun: false });
  assert.equal(out.results[0].outcome, 'voided');
  assert.equal(d.calls.cancelOrder.length, 0);
  assert.deepEqual(d.calls.markCancelled, ['row-IC-1']);
});

test('a replacement is never cancelled here, however old', async () => {
  const d = deps([order({ razorpay_order_id: 'IC-R-1', created_at: daysAgo(15) })]);
  const out = await runVoid(d, ['IC-R-1'], { dryRun: false });
  assert.equal(out.results[0].plan, 'held_replacement');
  assert.equal(d.calls.cancelOrder.length, 0);
});

test('a parcel XpressBees will not stop is left completely alone', async () => {
  const d = deps([order({ nimbus_pushed_at: daysAgo(11) })], {
    cancelCourier: async () => ({ action: 'moving', message: 'in transit' }),
  });
  const out = await runVoid(d, ['IC-1'], { dryRun: false });
  assert.equal(out.results[0].outcome, 'not_stopped');
  assert.deepEqual([d.calls.cancelNimbus, d.calls.cancelOrder, d.calls.markCancelled], [[], [], []]);
});

test('a dry run flags a moving parcel', async () => {
  const d = deps([order()], { xbTrack: async () => ({ status: 'in transit' }) });
  assert.equal((await runVoid(d, ['IC-1'])).results[0].outcome, 'moving');
});

test('delivered, cancelled, other couriers and unknown ids are skipped', async () => {
  const d = deps([order({ razorpay_order_id: 'IC-D', status: 'delivered' }),
    order({ razorpay_order_id: 'IC-N', courier_name: 'NimbusPost' })]);
  const out = await runVoid(d, ['IC-D', 'IC-N', 'IC-X'], { dryRun: false });
  assert.deepEqual(out.results.map(r => r.outcome), ['skipped', 'skipped', 'not_found']);
  assert.equal(d.calls.cancelCourier.length, 0);
});

test('over HTTP it needs an admin', async () => {
  process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-secret';
  const { handler } = require('../courier-void-stuck');
  const res = await handler({ httpMethod: 'POST', path: '/.netlify/functions/courier-void-stuck', headers: {}, body: '{}' });
  assert.equal(res.statusCode, 401);
});
