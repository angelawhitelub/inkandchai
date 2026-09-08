import test from 'node:test';
import assert from 'node:assert';
import { edgePolicy, edgeCacheKey, isStorable, EDGE_HEADER } from '../../worker/cache-policy.mjs';

/* The expensive mistake here is caching something that belongs to one visitor
   and serving it to the next, so most of these are about refusing to cache. */

test('the real declared policies parse to the TTL they meant', () => {
  // Verbatim from the handlers. "durable" is Netlify's word and means nothing
  // to us; s-maxage is the shared-cache number and must win over max-age.
  assert.deepStrictEqual(edgePolicy('public, durable, s-maxage=3600, stale-while-revalidate=86400'),
    { cacheable: true, ttl: 3600, reason: 's-maxage' });
  assert.strictEqual(edgePolicy('public, durable, s-maxage=2592000, immutable').ttl, 2592000);
  assert.strictEqual(edgePolicy('public, max-age=600').ttl, 600);
  assert.strictEqual(edgePolicy('public, max-age=60, s-maxage=900').ttl, 900);
});

test('a private policy is never put in a shared cache', () => {
  // bot-insights declares exactly this. Caching it would serve one admin's
  // OpenAI-generated answer to whoever asked next.
  assert.strictEqual(edgePolicy('private, max-age=300').cacheable, false);
  for (const v of ['no-store', 'no-cache', 'public, no-store']) {
    assert.strictEqual(edgePolicy(v).cacheable, false, v);
  }
});

test('no policy, or a zero TTL, means no caching', () => {
  for (const v of [null, undefined, '', '   ', 'public', 'public, s-maxage=0', 'public, max-age=0']) {
    assert.strictEqual(edgePolicy(v).cacheable, false, JSON.stringify(v));
  }
});

const req = (url, headers = {}, method = 'GET') => new Request(url, { method, headers });

test('anything carrying identity is answered for that caller alone', () => {
  const u = 'https://inkandchai.in/.netlify/functions/catalog-search?q=x';
  assert.ok(edgeCacheKey(req(u)), 'a plain GET should be cacheable');
  for (const h of ['Authorization', 'Cookie', 'X-Admin-Key', 'X-Admin-Token']) {
    assert.strictEqual(edgeCacheKey(req(u, { [h]: 'v' })), null, `${h} must bypass the cache`);
  }
});

test('only GET is cached', () => {
  const u = 'https://inkandchai.in/.netlify/functions/catalog-search';
  for (const m of ['POST', 'PUT', 'DELETE']) {
    assert.strictEqual(edgeCacheKey(req(u, {}, m)), null, m);
  }
});

test('query order does not mint a second cache entry', () => {
  const a = edgeCacheKey(req('https://x.test/f?b=2&a=1'));
  const b = edgeCacheKey(req('https://x.test/f?a=1&b=2'));
  assert.strictEqual(a.url, b.url);
  // ...and our own cache-busters are stripped rather than filling the cache
  // with entries that can never be hit again.
  const c = edgeCacheKey(req('https://x.test/f?a=1&_=999'));
  assert.strictEqual(c.url, b.url.replace('&b=2', ''));
});

test('a response that could leak a session is not storable', () => {
  const ok = new Response('x', { status: 200 });
  assert.ok(isStorable(ok));
  assert.strictEqual(isStorable(new Response('x', { status: 500 })), false);
  assert.strictEqual(isStorable(new Response('x', { status: 302 })), false);
  assert.strictEqual(isStorable(new Response('x', { headers: { 'Set-Cookie': 'a=b' } })), false);
  assert.strictEqual(isStorable(new Response('x', { headers: { Vary: 'Cookie' } })), false);
  assert.strictEqual(isStorable(new Response('x', { headers: { Vary: '*' } })), false);
});

test('the header name matches what the handlers actually send', () => {
  assert.strictEqual(EDGE_HEADER, 'Netlify-CDN-Cache-Control');
});
