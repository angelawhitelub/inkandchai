const test = require('node:test');
const assert = require('node:assert');
const { purgeCacheTags, purgeAplus, purgeProductSlugs, PRODUCT_TAGS } = require('./purge-cache');

const KEYS = ['CF_ZONE_ID', 'CF_PURGE_TOKEN', 'SITE_URL'];

const withEnv = async (env, fn) => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const savedFetch = global.fetch;
  Object.assign(process.env, env);
  try { return await fn(); }
  finally {
    global.fetch = savedFetch;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
};

test('without purge credentials it is a no-op, not an error', async () => {
  // A purge failure must never fail a save that already succeeded.
  await withEnv({ CF_ZONE_ID: '', CF_PURGE_TOKEN: '' }, async () => {
    assert.deepStrictEqual(await purgeCacheTags(['product-overrides']), { purged: false, reason: 'not-configured' });
  });
});

test('no tags means nothing to purge', async () => {
  assert.deepStrictEqual(await purgeCacheTags([]), { purged: false, reason: 'no-tags' });
  assert.deepStrictEqual(await purgeCacheTags(null), { purged: false, reason: 'no-tags' });
});

test('purges by URL against the zone endpoint', async () => {
  await withEnv({ CF_ZONE_ID: 'zone-123', CF_PURGE_TOKEN: 'tok' }, async () => {
    let seen = null;
    global.fetch = async (url, opts) => { seen = { url, opts }; return { ok: true }; };
    const out = await purgeCacheTags('product-overrides');
    assert.strictEqual(out.purged, true);
    assert.strictEqual(seen.url, 'https://api.cloudflare.com/client/v4/zones/zone-123/purge_cache');
    assert.strictEqual(seen.opts.headers.Authorization, 'Bearer tok');
    const files = JSON.parse(seen.opts.body).files;
    assert.ok(files.every((u) => u.startsWith('https://')), 'purge-by-URL needs absolute URLs');
    assert.ok(files.includes('https://inkandchai.in/'), 'the homepage embeds product data');
  });
});

test('a rejected or throwing purge is reported, never thrown', async () => {
  await withEnv({ CF_ZONE_ID: 'z', CF_PURGE_TOKEN: 't' }, async () => {
    global.fetch = async () => ({ ok: false, status: 503 });
    assert.deepStrictEqual(await purgeCacheTags(['products']), { purged: false, reason: 'http-503' });
    global.fetch = async () => { throw new Error('socket hang up'); };
    assert.deepStrictEqual(await purgeCacheTags(['products']), { purged: false, reason: 'socket hang up' });
  });
});

test('a product save still covers the legacy tag', async () => {
  assert.deepStrictEqual(PRODUCT_TAGS, ['products', 'product-overrides']);
});

test('an A+ save also purges the product URLs', async () => {
  // The product page embeds A+ modules in its HTML, so purging only the A+
  // endpoint would leave that page rendering the old ones.
  await withEnv({ CF_ZONE_ID: 'z', CF_PURGE_TOKEN: 't' }, async () => {
    let files = null;
    global.fetch = async (_u, opts) => { files = JSON.parse(opts.body).files; return { ok: true }; };
    await purgeAplus();
    assert.ok(files.includes('https://inkandchai.in/feed.xml'), 'aplus purge must reach the product feed');
  });
});

test('slug purges hit the individual product pages', async () => {
  await withEnv({ CF_ZONE_ID: 'z', CF_PURGE_TOKEN: 't' }, async () => {
    let files = null;
    global.fetch = async (_u, opts) => { files = JSON.parse(opts.body).files; return { ok: true }; };
    await purgeProductSlugs(['can-t-hurt-me-hindi-me-hi']);
    assert.ok(files.includes('https://inkandchai.in/product/can-t-hurt-me-hindi-me-hi/'));
  });
});

test('purge-by-URL is chunked to Cloudflare’s 30-URL cap', async () => {
  await withEnv({ CF_ZONE_ID: 'z', CF_PURGE_TOKEN: 't' }, async () => {
    const calls = [];
    global.fetch = async (_u, opts) => { calls.push(JSON.parse(opts.body).files.length); return { ok: true }; };
    const slugs = Array.from({ length: 70 }, (_, i) => `slug-${i}`);
    await purgeProductSlugs(slugs);
    assert.ok(calls.length >= 3, `expected chunking, got ${calls.length} call(s)`);
    assert.ok(calls.every((n) => n <= 30), `a chunk exceeded the cap: ${calls}`);
  });
});
