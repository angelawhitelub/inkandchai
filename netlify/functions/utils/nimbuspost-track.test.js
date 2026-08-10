/**
 * Tests for the live "has the courier got it?" check.
 *
 * Regression origin: replacement order IC-R-20260807-P7DX5, AWB 23645498153730.
 * Delhivery scanned it PICKED at 17:48 on 10 Aug 2026. The customer cancelled
 * at 23:5x that night and the site allowed it, because the only evidence the
 * guard consulted (orders.shipment_moved_at / last_nimbuspost_status) was NULL —
 * NimbusPost sends "picked", which nimbuspost-webhook.js did not map, so the
 * event was dropped without a trace. NimbusPost then refused the auto-cancel,
 * correctly, and the parcel shipped anyway.
 *
 * The fail-open cases matter as much as the blocking one: a NimbusPost outage
 * must never trap a customer in an order that is genuinely still on our shelf.
 */

const test = require('node:test');
const assert = require('node:assert');
const { npShipmentMoved, statusImpliesMovement } = require('./nimbuspost-track');

process.env.NIMBUSPOST_EMAIL = process.env.NIMBUSPOST_EMAIL || 'test@example.invalid';
process.env.NIMBUSPOST_PASSWORD = process.env.NIMBUSPOST_PASSWORD || 'test-password';

const AWB = '23645498153730';

// Verbatim shape of the real /shipments/track/bulk reply for that AWB.
const PICKED_ROW = {
  awb_number: AWB,
  order_number: 'IC-R-20260807-P7DX5',
  courier_name: 'Delhivery',
  status: 'picked',
  event_time: '2026-08-10 22:01:54',
  history: [
    { status_code: 'PICKED', location: 'Faridabad_MathuraRoad_GW (Haryana)', event_time: '2026-08-10 17:48', message: 'Shipment picked up' },
    { status_code: 'PP', location: 'Faridabad_MathuraRoad_GW (Haryana)', event_time: '2026-08-10 11:23', message: 'Out for Pickup' },
  ],
};

function trackFetch(payload, { ok = true, throws = null, hang = false } = {}) {
  return (url, opts) => {
    if (throws) return Promise.reject(throws);
    if (hang) {
      return new Promise((_, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
        });
      });
    }
    if (String(url).includes('/users/login')) {
      return Promise.resolve({ ok: true, json: async () => ({ data: 'tok_test' }) });
    }
    return Promise.resolve({ ok, json: async () => payload });
  };
}

const bulk = (rows) => ({ status: true, data: rows });

// ── the status vocabulary ───────────────────────────────────────────────────
test('"picked" counts as movement — the whole point', () => {
  assert.strictEqual(statusImpliesMovement('picked'), true);
  assert.strictEqual(statusImpliesMovement('PICKED'), true);
  assert.strictEqual(statusImpliesMovement('Picked'), true);
});

test('the old pattern only knew "picked up", so check both still pass', () => {
  for (const s of ['picked up', 'pickup done', 'in transit', 'spd', 'out for delivery',
                   'delivered', 'rto in transit', 'ndr', 'lost']) {
    assert.strictEqual(statusImpliesMovement(s), true, `${s} should count as moved`);
  }
});

test('pre-pickup scans are NOT movement — the parcel is still ours', () => {
  for (const s of ['', null, undefined, 'manifested', 'booked', 'pickup scheduled',
                   'pickup pending', 'shipment booked', 'out for pickup', 'pp']) {
    assert.strictEqual(statusImpliesMovement(s), false, `${s} must not block cancellation`);
  }
});

// ── the live lookup ─────────────────────────────────────────────────────────
test('REGRESSION: the AWB that shipped anyway now reports moved', async () => {
  const res = await npShipmentMoved(AWB, { fetchImpl: trackFetch(bulk([PICKED_ROW])) });
  assert.strictEqual(res.moved, true);
  assert.strictEqual(res.status, 'picked');
});

test('a headline status lagging its own history still counts as moved', async () => {
  const lagging = { ...PICKED_ROW, status: 'pending pickup' };
  const res = await npShipmentMoved(AWB, { fetchImpl: trackFetch(bulk([lagging])) });
  assert.strictEqual(res.moved, true, 'the PICKED scan in history must win');
});

test('a parcel still awaiting pickup reports NOT moved', async () => {
  const waiting = { awb_number: AWB, status: 'pending pickup',
                    history: [{ status_code: 'PP', message: 'Out for Pickup' }] };
  const res = await npShipmentMoved(AWB, { fetchImpl: trackFetch(bulk([waiting])) });
  assert.strictEqual(res.moved, false);
});

test('the right AWB is read out of a multi-row response', async () => {
  const other = { awb_number: '99999999999999', status: 'delivered' };
  const waiting = { awb_number: AWB, status: 'manifested' };
  const res = await npShipmentMoved(AWB, { fetchImpl: trackFetch(bulk([other, waiting])) });
  assert.strictEqual(res.moved, false, 'must not inherit another shipment\'s status');
});

// ── fail-open paths: unknown is never a refusal ─────────────────────────────
test('a network error is unknown, not "moved"', async () => {
  const res = await npShipmentMoved(AWB, { fetchImpl: trackFetch(null, { throws: new Error('ECONNRESET') }) });
  assert.strictEqual(res.moved, null);
});

test('a timeout is unknown, and returns promptly', async () => {
  const started = Date.now();
  const res = await npShipmentMoved(AWB, { fetchImpl: trackFetch(null, { hang: true }), timeoutMs: 60 });
  assert.strictEqual(res.moved, null);
  assert.strictEqual(res.error, 'timeout');
  assert.ok(Date.now() - started < 2000, 'must not hang a customer on the Cancel button');
});

test('a non-ok status, a false envelope and junk bodies are all unknown', async () => {
  assert.strictEqual((await npShipmentMoved(AWB, { fetchImpl: trackFetch(bulk([PICKED_ROW]), { ok: false }) })).moved, null);
  assert.strictEqual((await npShipmentMoved(AWB, { fetchImpl: trackFetch({ status: false, message: 'nope' }) })).moved, null);
  for (const body of [null, {}, 'nonsense', { status: true, data: [] }]) {
    assert.strictEqual((await npShipmentMoved(AWB, { fetchImpl: trackFetch(body) })).moved, null);
  }
});

test('missing credentials are unknown, so cancellation still works', async () => {
  const email = process.env.NIMBUSPOST_EMAIL, pw = process.env.NIMBUSPOST_PASSWORD;
  delete process.env.NIMBUSPOST_EMAIL; delete process.env.NIMBUSPOST_PASSWORD;
  try {
    assert.strictEqual((await npShipmentMoved(AWB, { fetchImpl: trackFetch(bulk([PICKED_ROW])) })).moved, null);
  } finally {
    process.env.NIMBUSPOST_EMAIL = email; process.env.NIMBUSPOST_PASSWORD = pw;
  }
});

test('no AWB and no fetch are unknown, and never call out', async () => {
  assert.strictEqual((await npShipmentMoved('', { fetchImpl: trackFetch(bulk([PICKED_ROW])) })).moved, null);
  // `undefined` would fall through to the globalThis.fetch default and hit the
  // network, so pass an explicit non-function to exercise the guard.
  assert.strictEqual((await npShipmentMoved(AWB, { fetchImpl: null })).moved, null);
});
