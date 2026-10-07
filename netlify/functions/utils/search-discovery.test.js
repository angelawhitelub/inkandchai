'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('withTimeout falls back when the work never settles', async () => {
  const { withTimeout } = require('./search-discovery');
  const t0 = Date.now();
  assert.equal(await withTimeout(new Promise(() => {}), 50, 'fallback'), 'fallback');
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(await withTimeout(Promise.resolve('done'), 50, 'fallback'), 'done');
});

test('a hung bestseller fetch cannot hang discovery, for this request or the next', async () => {
  const realFetch = global.fetch;
  const env = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY };
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;
  global.fetch = () => new Promise(() => {});   // never answers, ignores the abort signal
  try {
    const discovery = require('./search-discovery');
    const catalog = [{ slug: 'atomic-habits', title: 'Atomic Habits', author: 'James Clear', category: 'Self Help', price: 299, mrp: 499, url: '/product/atomic-habits/' }];
    const prefs = discovery.preferences({});
    const t0 = Date.now();
    const [a, b] = await Promise.all([discovery.discover(catalog, prefs, new Set()), discovery.discover(catalog, prefs, new Set())]);
    assert.ok(Date.now() - t0 < 6000, 'both requests settle');
    assert.deepEqual(a.bestsellers, []);
    assert.equal(b.featured[0].slug, 'atomic-habits');
  } finally {
    global.fetch = realFetch;
    if (env.url) process.env.SUPABASE_URL = env.url;
    if (env.key) process.env.SUPABASE_SERVICE_KEY = env.key;
  }
});
