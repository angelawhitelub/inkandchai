import test from 'node:test';
import assert from 'node:assert';
import { renderWithLastGood, staleProductKey, STALE_TTL } from '../../worker/cache-policy.mjs';

// The Cache API, keyed by URL, in memory.
function memCache() {
  const m = new Map();
  return {
    m,
    async match(key) { const r = m.get(key.url); return r ? r.clone() : undefined; },
    async put(key, res) { m.set(key.url, new Response(await res.text(), res)); },
  };
}
const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
const key = staleProductKey('https://inkandchai.in', 'Becoming-Supernatural');

async function run(render, cache, timeoutMs = 50) {
  const waits = [];
  const res = await renderWithLastGood(render, { cache, key, waitUntil: (p) => waits.push(p), timeoutMs });
  await Promise.all(waits);
  return res;
}

test('a good render is served and kept as the last-good copy', async () => {
  const cache = memCache();
  const res = await run(() => html('<h1>Becoming Supernatural</h1>'), cache);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<h1>Becoming Supernatural</h1>');
  assert.equal(key.url, 'https://inkandchai.in/__last-good/product/becoming-supernatural/');
  const kept = cache.m.get(key.url);
  assert.ok(kept);
  assert.equal(kept.headers.get('Cache-Control'), `public, max-age=${STALE_TTL}`);
});

test('database down (503): the last-good copy is served as a 200', async () => {
  const cache = memCache();
  await run(() => html('<h1>Good copy</h1>'), cache);
  const res = await run(() => html('Just a moment', 503), cache);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Product-Source'), 'last-good');
  assert.equal(await res.text(), '<h1>Good copy</h1>');
});

test('render hangs past the limit: the last-good copy, and the late render still refreshes it', async () => {
  const cache = memCache();
  await run(() => html('<h1>Old</h1>'), cache);
  const res = await run(() => new Promise((r) => setTimeout(() => r(html('<h1>New</h1>')), 120)), cache, 20);
  assert.equal(await res.text(), '<h1>Old</h1>');
  assert.equal(await cache.m.get(key.url).clone().text(), '<h1>New</h1>');
});

test('a removed product (404) is never brought back from the copy', async () => {
  const cache = memCache();
  await run(() => html('<h1>Was here</h1>'), cache);
  const res = await run(() => html('not found', 404), cache);
  assert.equal(res.status, 404);
});

test('no copy in this location yet: the real answer, even a slow 503', async () => {
  const cache = memCache();
  const failed = await run(() => html('Just a moment', 503), cache);
  assert.equal(failed.status, 503);
  const slow = await run(() => new Promise((r) => setTimeout(() => r(html('<h1>Slow but fine</h1>')), 60)), cache, 10);
  assert.equal(slow.status, 200);
  assert.equal(await slow.text(), '<h1>Slow but fine</h1>');
});
