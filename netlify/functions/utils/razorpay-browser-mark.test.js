'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('./razorpay-browser-mark');

function fakeKv() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
  };
}

test('a payment the browser came back for gets no recovery alert', async () => {
  const kv = fakeKv();
  assert.equal(await m.markBrowserReturned('pay_A', { kv }), true);
  let alerted = 0;
  const r = await m.alertUnlessBrowserReturned('pay_A', async () => { alerted++; }, { kv, graceMs: 0 });
  assert.equal(r, 'browser');
  assert.equal(alerted, 0);
});

test('a payment the browser never came back for is a real recovery', async () => {
  const kv = fakeKv();
  await m.markBrowserReturned('pay_OTHER', { kv });
  let alerted = 0;
  const r = await m.alertUnlessBrowserReturned('pay_B', async () => { alerted++; }, { kv, graceMs: 0 });
  assert.equal(r, 'alerted');
  assert.equal(alerted, 1);
});

test('without KV, or with KV failing, the alert still goes (old behaviour)', async () => {
  let alerted = 0;
  await m.alertUnlessBrowserReturned('pay_C', async () => { alerted++; }, { kv: undefined, graceMs: 0 });
  const broken = { get: async () => { throw new Error('down'); }, put: async () => { throw new Error('down'); } };
  assert.equal(await m.markBrowserReturned('pay_C', { kv: broken }), false);
  await m.alertUnlessBrowserReturned('pay_C', async () => { alerted++; }, { kv: broken, graceMs: 0 });
  assert.equal(alerted, 2);
});

test('the grace period fits inside Cloudflare waitUntil (30 s)', () => {
  assert.ok(m.GRACE_MS > 5000 && m.GRACE_MS <= 25000);
});
