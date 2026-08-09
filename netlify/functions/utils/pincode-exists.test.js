/**
 * Tests for the server-side pincode EXISTENCE gate.
 *
 * Regression origin: order IC-20260809-5KM86 shipped to "Lucknow, Uttar
 * Pradesh - 206014". 206014 is well-formed and not junk-patterned, so
 * isFakePincode passed it, and the only existence check lived in the browser.
 * India Post has no record of 206014 at all.
 *
 * The fail-open cases below are as important as the blocking one: a flaky
 * upstream must never stop a real customer from ordering.
 */

const test = require('node:test');
const assert = require('node:assert');
const { pincodeExists, pincodeRejection, isFakePincode, _resetNpToken } = require('./pincode-valid');

// The courier stage is skipped entirely when credentials are absent (fail open),
// so the blocking tests below need them present. Every upstream call is stubbed;
// nothing here touches the real NimbusPost.
process.env.NIMBUSPOST_EMAIL = process.env.NIMBUSPOST_EMAIL || 'test@example.invalid';
process.env.NIMBUSPOST_PASSWORD = process.env.NIMBUSPOST_PASSWORD || 'test-password';

// Minimal fetch double. `payload` is what res.json() resolves to.
function fakeFetch(payload, { ok = true, throws = null, hang = false } = {}) {
  return (url, opts) => {
    if (throws) return Promise.reject(throws);
    if (hang) {
      // Never resolves on its own — only the abort signal ends it.
      return new Promise((_, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return Promise.resolve({ ok, json: () => Promise.resolve(payload) });
  };
}

const FOUND = [{ Message: 'Number of pincode(s) found:1', Status: 'Success',
                 PostOffice: [{ Name: 'Hazratganj', District: 'Lucknow', State: 'Uttar Pradesh' }] }];
const NOT_FOUND = [{ Message: 'No records found', Status: 'Error', PostOffice: null }];

test('a real pincode resolves true', async () => {
  assert.strictEqual(await pincodeExists('226001', { fetchImpl: fakeFetch(FOUND) }), true);
});

test('206014 — the pincode that actually shipped — resolves false', async () => {
  assert.strictEqual(await pincodeExists('206014', { fetchImpl: fakeFetch(NOT_FOUND) }), false);
});

test('isFakePincode alone does NOT catch 206014 (why the gate was needed)', () => {
  assert.strictEqual(isFakePincode('206014'), false);
});

test('non-6-digit input is unknown, not a denial', async () => {
  // Note '20601a4' is NOT here on purpose: stray characters are stripped, so it
  // is the 6-digit 206014 and must be judged on its merits, not waved through.
  for (const bad of ['', '2060', '2060144', '000000', null, undefined]) {
    assert.strictEqual(await pincodeExists(bad, { fetchImpl: fakeFetch(NOT_FOUND) }), null);
  }
});

test('stray characters are stripped before judging', async () => {
  assert.strictEqual(await pincodeExists('20601a4', { fetchImpl: fakeFetch(NOT_FOUND) }), false);
  assert.strictEqual(await pincodeExists(' 226 001 ', { fetchImpl: fakeFetch(FOUND) }), true);
});

// ── fail-open paths ─────────────────────────────────────────────────────────
test('a network error resolves null, never false', async () => {
  const impl = fakeFetch(null, { throws: new Error('ECONNRESET') });
  assert.strictEqual(await pincodeExists('226001', { fetchImpl: impl }), null);
});

test('a non-ok HTTP status resolves null', async () => {
  assert.strictEqual(await pincodeExists('226001', { fetchImpl: fakeFetch(FOUND, { ok: false }) }), null);
});

test('a timeout resolves null rather than blocking the order', async () => {
  const started = Date.now();
  const res = await pincodeExists('226001', { fetchImpl: fakeFetch(null, { hang: true }), timeoutMs: 60 });
  assert.strictEqual(res, null);
  assert.ok(Date.now() - started < 2000, 'should abort promptly, not hang checkout');
});

test('an unexpected body shape resolves null', async () => {
  for (const body of [null, {}, [], [{}], 'nonsense']) {
    assert.strictEqual(await pincodeExists('226001', { fetchImpl: fakeFetch(body) }), null);
  }
});

test('an unrecognised error message resolves null, not false', async () => {
  const weird = [{ Message: 'Rate limit exceeded', Status: 'Error', PostOffice: null }];
  assert.strictEqual(await pincodeExists('226001', { fetchImpl: fakeFetch(weird) }), null);
});

test('no fetch available in the runtime resolves null', async () => {
  // `undefined` would fall through to the globalThis.fetch default (and hit the
  // real network), so pass an explicit non-function to exercise the guard.
  assert.strictEqual(await pincodeExists('226001', { fetchImpl: null }), null);
});

// ── the shared guard used by all three order endpoints ──────────────────────
// Two-stage: India Post miss alone must NOT block (its dataset is incomplete);
// only a confirmed zero-courier answer does. Routes by URL so one double can
// answer for both upstreams.
function stagedFetch({ postal, couriers }) {
  return (url) => {
    if (String(url).includes('postalpincode')) {
      return Promise.resolve({ ok: true, json: async () => postal });
    }
    if (String(url).includes('/users/login')) {
      return Promise.resolve({ ok: true, json: async () => ({ data: 'tok_test' }) });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ status: true, data: Array.from({ length: couriers }, (_, i) => ({ id: i })) }),
    });
  };
}

test('guard blocks only when NO courier serves the pincode', async () => {
  _resetNpToken();
  const bad = await pincodeRejection({ pincode: '206014' },
    { fetchImpl: stagedFetch({ postal: NOT_FOUND, couriers: 0 }) });
  assert.strictEqual(bad?.code, 'pincode_undeliverable');
});

test('REGRESSION: a pincode India Post lacks but couriers serve is ALLOWED', async () => {
  // 452008 (Indore), 122022 (Gurgaon), 560114, 440004, 201318, 400036 are all
  // absent from India Post yet served by 22–37 couriers, and 34 such orders had
  // already been delivered. Blocking these would refuse real customers.
  _resetNpToken();
  for (const pin of ['452008', '122022', '440004', '560114', '201318', '400036']) {
    const res = await pincodeRejection({ pincode: pin },
      { fetchImpl: stagedFetch({ postal: NOT_FOUND, couriers: 25 }) });
    assert.strictEqual(res, null, `${pin} must not be blocked`);
  }
});

test('a courier lookup that fails resolves null → order allowed', async () => {
  _resetNpToken();
  const impl = (url) => String(url).includes('postalpincode')
    ? Promise.resolve({ ok: true, json: async () => NOT_FOUND })
    : Promise.reject(new Error('nimbus down'));
  assert.strictEqual(await pincodeRejection({ pincode: '206014' }, { fetchImpl: impl }), null);
});

test('missing NimbusPost credentials → unknown, order allowed', async () => {
  _resetNpToken();
  const email = process.env.NIMBUSPOST_EMAIL, pw = process.env.NIMBUSPOST_PASSWORD;
  delete process.env.NIMBUSPOST_EMAIL; delete process.env.NIMBUSPOST_PASSWORD;
  try {
    const res = await pincodeRejection({ pincode: '206014' },
      { fetchImpl: stagedFetch({ postal: NOT_FOUND, couriers: 0 }) });
    assert.strictEqual(res, null);
  } finally {
    process.env.NIMBUSPOST_EMAIL = email;
    process.env.NIMBUSPOST_PASSWORD = pw;
  }
});

test('a pincode India Post knows never reaches the courier check', async () => {
  _resetNpToken();
  let courierCalled = false;
  const impl = (url) => {
    if (String(url).includes('postalpincode')) {
      return Promise.resolve({ ok: true, json: async () => FOUND });
    }
    courierCalled = true;
    return Promise.resolve({ ok: true, json: async () => ({ status: true, data: [] }) });
  };
  assert.strictEqual(await pincodeRejection({ pincode: '226001' }, { fetchImpl: impl }), null);
  assert.strictEqual(courierCalled, false, 'the expensive check must stay rare');
});

test('guard blocks junk without ever calling the network', async () => {
  let called = false;
  const impl = () => { called = true; return Promise.resolve({ ok: true, json: async () => FOUND }); };
  const bad = await pincodeRejection({ pincode: '123456' }, { fetchImpl: impl });
  assert.strictEqual(bad?.code, 'invalid_pincode');
  assert.strictEqual(called, false, 'junk is rejected locally, no upstream call');
});

test('guard allows a real pincode', async () => {
  _resetNpToken();
  assert.strictEqual(await pincodeRejection({ pincode: '226001' }, { fetchImpl: fakeFetch(FOUND) }), null);
});

test('guard allows when no pincode is present at all', async () => {
  assert.strictEqual(await pincodeRejection({}, { fetchImpl: fakeFetch(NOT_FOUND) }), null);
  assert.strictEqual(await pincodeRejection(null, { fetchImpl: fakeFetch(NOT_FOUND) }), null);
});

test('guard allows when the lookup is unreachable (fail open)', async () => {
  _resetNpToken();
  const impl = fakeFetch(null, { throws: new Error('offline') });
  assert.strictEqual(await pincodeRejection({ pincode: '226001' }, { fetchImpl: impl }), null);
});

test('guard reads the pincode off the address line when no field is given', async () => {
  _resetNpToken();
  const customer = { address: '15/33 Sharada Nagar, Lucknow, Uttar Pradesh, 206014' };
  const bad = await pincodeRejection(customer, { fetchImpl: stagedFetch({ postal: NOT_FOUND, couriers: 0 }) });
  assert.strictEqual(bad?.code, 'pincode_undeliverable');
});
