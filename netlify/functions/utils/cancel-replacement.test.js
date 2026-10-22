const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { replacementRefundPlan, shipmentStopState } = require('./missing-books');

const FN_DIR = path.join(__dirname, '..');
const FN = path.join(FN_DIR, 'cancel-replacement.js');
const SUPA = require.resolve('@supabase/supabase-js');

const original = (over = {}) => ({
  id: 'orig-uuid', razorpay_order_id: 'IC-20260920-3QYRH', status: 'delivered',
  razorpay_payment_id: 'pay_TeG3lueMCQPpqh', amount_paise: 73786,
  cart_items: [{ title: 'How to Win Friends', price: 179.1, qty: 1 }, { title: 'Psycho-Cybernetics', price: 191.76, qty: 1 }],
  ...over,
});
const replacement = (over = {}, meta = {}) => ({
  id: '0f8e1c2a-1111-4222-8333-444455556666', razorpay_order_id: 'IC-R-20260929-CGJLC', source: 'replacement', status: 'replacement_pending',
  amount_paise: 0, tracking_id: null,
  cart_items: [{ title: 'How to Win Friends', price: 179.1, qty: 1,
    _replacement: { reason: 'missing_item', original_order_id: 'IC-20260920-3QYRH', ...meta } }],
  ...over,
});

// ── The decision ─────────────────────────────────────────────────────────────

test('a prepaid missing book is refunded for exactly what the missing books cost', () => {
  const plan = replacementRefundPlan(replacement(), original());
  assert.equal(plan.action, 'gateway');
  assert.equal(plan.gateway, 'razorpay');
  assert.equal(plan.amountPaise, 17910);
  assert.deepEqual(plan.items, [{ title: 'How to Win Friends', qty: 1, amount: 179 }]);

  const two = replacement({ cart_items: [
    { title: 'A', price: 199, qty: 2, _replacement: { reason: 'incomplete_set', original_order_id: 'IC-20260920-3QYRH' } },
    { title: 'B', price: 249, qty: 1 },
  ] });
  assert.equal(replacementRefundPlan(two, original()).amountPaise, 64700);
  assert.equal(replacementRefundPlan(replacement(), original({ razorpay_payment_id: 'OMO123' })).gateway, 'phonepe');
});

test('a replacement of a free replacement is never treated as COD', () => {
  const middle = original({ razorpay_order_id: 'IC-R-20260921-0T4CG', source: 'replacement', razorpay_payment_id: null, amount_paise: 0,
    cart_items: [{ title: 'How to Win Friends', price: 179.1, qty: 1, _replacement: { reason: 'missing_item', original_order_id: 'IC-20260915-AAAAA' } }] });
  const plan = replacementRefundPlan(replacement({}, { original_order_id: 'IC-R-20260921-0T4CG' }), middle);
  assert.equal(plan.action, 'manual');
  assert.match(plan.reason, /itself a free replacement/);
});

test('nothing is refunded for a replacement that is not about missing books', () => {
  assert.equal(replacementRefundPlan(replacement({}, { reason: 'damaged' }), original()).action, 'none');
  assert.equal(replacementRefundPlan(replacement({}, { reason: 'missing_pages' }), original()).action, 'none');
});

test('a COD original is sent to the UPI flow, never a gateway', () => {
  assert.equal(replacementRefundPlan(replacement(), original({ razorpay_payment_id: null, status: 'delivered' })).action, 'upi');
});

test('any earlier refund on the original stops an automatic second one', () => {
  for (const over of [
    { status: 'partially_refunded' }, { status: 'refunded' }, { status: 'refund_pending' }, { status: 'refund_failed' },
    { refund_id: 'rfnd_1' }, { refund_state: 'COMPLETED' },
  ]) {
    assert.equal(replacementRefundPlan(replacement(), original(over)).action, 'manual', JSON.stringify(over));
  }
});

test('an already-refunded, half-started or unpriced replacement is not refunded again', () => {
  assert.equal(replacementRefundPlan(replacement({}, { refund_issued_at: '2026-09-29T00:00:00Z' }), original()).action, 'none');
  assert.equal(replacementRefundPlan(replacement({}, { refund_paid_at: '2026-09-29T00:00:00Z' }), original()).action, 'none');
  assert.equal(replacementRefundPlan(replacement({}, { refund_claimed_at: '2026-09-29T00:00:00Z' }), original()).action, 'manual');
  const unpriced = replacement({ cart_items: [{ title: 'A', _replacement: { reason: 'missing_item', original_order_id: 'IC-20260920-3QYRH' } }] });
  assert.equal(replacementRefundPlan(unpriced, original()).action, 'manual');
});

test('partial COD, more than was paid, or a missing original need a person', () => {
  const partial = original({ cart_items: [{ title: 'How to Win Friends', price: 179.1, qty: 1, _payment: { mode: 'partial_cod' } }] });
  assert.equal(replacementRefundPlan(replacement(), partial).action, 'manual');
  assert.equal(replacementRefundPlan(replacement(), original({ amount_paise: 10000 })).action, 'manual');
  assert.equal(replacementRefundPlan(replacement(), null).action, 'manual');
});

test('a parcel counts as stopped only when a courier said so', () => {
  assert.equal(shipmentStopState(replacement()).stopped, true);                       // never left us
  const awb = replacement({ tracking_id: '1344', courier_name: 'XpressBees' });
  assert.equal(shipmentStopState(awb, { courier: { action: 'cancelled' } }).stopped, true);
  assert.equal(shipmentStopState(awb, { courier: { action: 'moving', message: 'in transit' } }).stopped, false);
  assert.equal(shipmentStopState(awb, { courier: { action: 'error' } }).stopped, false);
  assert.equal(shipmentStopState(awb, { courier: { action: 'not_supported' }, nimbus: { ok: true } }).stopped, true);
  assert.equal(shipmentStopState(replacement({ nimbus_pushed_at: 'x' }), { nimbus: { ok: true } }).stopped, true);
  assert.equal(shipmentStopState(replacement({ nimbus_pushed_at: 'x' }), { nimbus: { ok: false } }).stopped, 'unknown');
  assert.equal(shipmentStopState(replacement({ xpressbees_feed_at: 'x' })).stopped, 'unknown');
  assert.equal(shipmentStopState(replacement({ ithink_pushed_at: 'x' })).stopped, 'unknown');
});

// ── The endpoint, with the database, couriers and gateways stubbed ──────────

function stubDb(rows) {
  const where = (filter) => rows.find(r => r[filter[0]] === filter[1]) || null;
  return {
    from: () => {
      let filter = null; let patch = null;
      const q = {
        select: () => q,
        update: (p) => { patch = p; return q; },
        eq: (col, val) => {
          filter = [col, val];
          if (patch) { const row = where(filter); if (row) Object.assign(row, JSON.parse(JSON.stringify(patch))); return Promise.resolve({ error: null }); }
          return q;
        },
        maybeSingle: () => Promise.resolve({ data: where(filter) ? JSON.parse(JSON.stringify(where(filter))) : null, error: null }),
      };
      return q;
    },
  };
}

function load({ rows, courier = null, nimbus = { ok: true }, refund }) {
  const calls = { status: [], refund: [], nimbus: [] };
  const stub = (rel, exports) => {
    const file = require.resolve(path.join(FN_DIR, rel));
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  };
  delete require.cache[FN];
  require.cache[SUPA] = { id: SUPA, filename: SUPA, loaded: true, exports: { createClient: () => stubDb(rows) } };
  stub('utils/admin-auth.js', { requireAdmin: () => null });
  stub('utils/courier-shipment-cancel.js', { cancelCourierShipment: async () => courier });
  stub('utils/nimbuspost-cancel.js', {
    cancelNimbusShipment: async (awb) => { calls.nimbus.push(awb); return nimbus; },
    cancelNimbusOrder: async (num) => { calls.nimbus.push(num); return nimbus; },
  });
  stub('update-order-status.js', { handler: async (ev) => {
    const b = JSON.parse(ev.body); calls.status.push(b);
    rows.find(r => r.id === b.id).status = b.status;
    return { statusCode: 200, body: JSON.stringify({ success: true, ...(courier ? { courier } : {}) }) };
  } });
  const refundStub = (gw) => ({ handler: async (ev) => { calls.refund.push({ gw, path: ev.path, ...JSON.parse(ev.body) }); return refund(); } });
  stub('razorpay-refund.js', refundStub('razorpay'));
  stub('phonepe-refund.js', refundStub('phonepe'));
  process.env.SUPABASE_URL = 'https://stub.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'stub';
  const handler = require(FN).handler;
  const run = (body) => handler({ httpMethod: 'POST', headers: { 'x-admin-key': 'k' }, path: '/.netlify/functions/cancel-replacement', body: JSON.stringify(body) })
    .then(r => ({ statusCode: r.statusCode, ...JSON.parse(r.body) }));
  return { run, calls };
}

const ok = () => ({ statusCode: 200, body: JSON.stringify({ success: true, state: 'COMPLETED', refund_id: 'rfnd_X', message: 'Partial refund of ₹179.10 issued via Razorpay.' }) });
const metaOf = (row) => row.cart_items.find(i => i._replacement)._replacement;

test('cancelling refunds the original once, then a second cancel does nothing', async () => {
  const rows = [replacement(), original()];
  const { run, calls } = load({ rows, refund: ok });

  const r = await run({ id: 'IC-R-20260929-CGJLC' });
  assert.equal(r.refund.status, 'issued');
  assert.deepEqual(calls.status, [{ id: '0f8e1c2a-1111-4222-8333-444455556666', status: 'cancelled', tracking_id: '', courier_name: '' }]);
  assert.equal(calls.refund.length, 1);
  assert.equal(calls.refund[0].gw, 'razorpay');
  assert.equal(calls.refund[0].path, '/.netlify/functions/razorpay-refund');   // its own staff check runs
  assert.equal(calls.refund[0].order_id, 'IC-20260920-3QYRH');
  assert.equal(calls.refund[0].amount_paise, 17910);
  const meta = metaOf(rows[0]);
  assert.ok(meta.refund_issued_at);
  assert.equal(meta.refund_ref, 'rfnd_X');
  assert.equal(meta.refund_claimed_at, undefined);

  const again = await run({ id: '0f8e1c2a-1111-4222-8333-444455556666' });
  assert.equal(again.refund.status, 'not_owed');
  assert.equal(calls.refund.length, 1);
});

test('dry run changes nothing', async () => {
  const rows = [replacement(), original()];
  const { run, calls } = load({ rows, refund: ok });
  const r = await run({ id: '0f8e1c2a-1111-4222-8333-444455556666', dry_run: true });
  assert.equal(r.plan.action, 'gateway');
  assert.equal(r.plan.amount_paise, 17910);
  assert.equal(calls.status.length + calls.refund.length, 0);
  assert.equal(rows[0].status, 'replacement_pending');
});

test('a parcel already moving is cancelled but NOT refunded', async () => {
  const rows = [replacement({ tracking_id: '134496', courier_name: 'XpressBees' }), original()];
  const { run, calls } = load({ rows, courier: { action: 'moving', message: 'XpressBees shipment 134496 is "In Transit", too late to cancel.' }, refund: ok });
  const r = await run({ id: '0f8e1c2a-1111-4222-8333-444455556666' });
  assert.equal(r.refund.status, 'withheld');
  assert.equal(calls.refund.length, 0);
  assert.equal(rows[0].status, 'cancelled');
});

test('a row in a panel we cannot check waits for the admin to confirm', async () => {
  const rows = [replacement({ xpressbees_feed_at: '2026-09-29T01:00:00Z' }), original()];
  const { run, calls } = load({ rows, refund: ok });
  const first = await run({ id: '0f8e1c2a-1111-4222-8333-444455556666' });
  assert.equal(first.refund.status, 'needs_confirm');
  assert.equal(calls.refund.length, 0);
  const second = await run({ id: '0f8e1c2a-1111-4222-8333-444455556666', confirm_stopped: true });
  assert.equal(second.cancelled.already, true);
  assert.equal(second.refund.status, 'issued');
  assert.equal(calls.refund.length, 1);
});

test('a refund that may have reached the gateway keeps its claim; a refused one clears it', async () => {
  const rows = [replacement(), original()];
  const { run, calls } = load({ rows, refund: () => ({ statusCode: 500, body: JSON.stringify({ error: 'timeout' }) }) });
  const r = await run({ id: '0f8e1c2a-1111-4222-8333-444455556666' });
  assert.equal(r.refund.status, 'failed');
  assert.ok(metaOf(rows[0]).refund_claimed_at);
  const retry = await run({ id: '0f8e1c2a-1111-4222-8333-444455556666' });
  assert.equal(retry.refund.status, 'manual');       // never a blind second refund
  assert.equal(calls.refund.length, 1);

  const rows2 = [replacement(), original()];
  const second = load({ rows: rows2, refund: () => ({ statusCode: 400, body: JSON.stringify({ error: 'Order status is x' }) }) });
  await second.run({ id: '0f8e1c2a-1111-4222-8333-444455556666' });
  assert.equal(metaOf(rows2[0]).refund_claimed_at, undefined);
});

test('a COD original is cancelled and handed to the UPI flow', async () => {
  const rows = [replacement(), original({ razorpay_payment_id: null })];
  const { run, calls } = load({ rows, refund: ok });
  const r = await run({ id: '0f8e1c2a-1111-4222-8333-444455556666' });
  assert.equal(r.refund.status, 'upi');
  assert.equal(r.refund.amount_paise, 17910);
  assert.equal(calls.refund.length, 0);
  assert.equal(rows[0].status, 'cancelled');
});

test('a delivered replacement is refused outright', async () => {
  const rows = [replacement({ status: 'delivered' }), original()];
  const { run, calls } = load({ rows, refund: ok });
  const r = await run({ id: '0f8e1c2a-1111-4222-8333-444455556666' });
  assert.equal(r.statusCode, 400);
  assert.equal(calls.status.length + calls.refund.length, 0);
});
