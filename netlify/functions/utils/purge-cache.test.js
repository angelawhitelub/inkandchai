const test = require('node:test');
const assert = require('node:assert');
const { purgeCacheTags } = require('./purge-cache');

const withEnv = async (env, fn) => {
  const saved = { SITE_ID: process.env.SITE_ID, NETLIFY_PURGE_API_TOKEN: process.env.NETLIFY_PURGE_API_TOKEN };
  const savedFetch = global.fetch;
  Object.assign(process.env, env);
  try { return await fn(); }
  finally {
    global.fetch = savedFetch;
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
};

test('outside the Netlify runtime it is a no-op, not an error', async () => {
  // A purge failure must never fail a save that already succeeded.
  await withEnv({ SITE_ID: '', NETLIFY_PURGE_API_TOKEN: '' }, async () => {
    assert.deepStrictEqual(await purgeCacheTags(['product-overrides']), { purged: false, reason: 'not-in-netlify-runtime' });
  });
});

test('no tags means nothing to purge', async () => {
  assert.deepStrictEqual(await purgeCacheTags([]), { purged: false, reason: 'no-tags' });
  assert.deepStrictEqual(await purgeCacheTags(null), { purged: false, reason: 'no-tags' });
});

test('posts the site id and tags to the purge API', async () => {
  await withEnv({ SITE_ID: 'site-123', NETLIFY_PURGE_API_TOKEN: 'tok' }, async () => {
    let seen = null;
    global.fetch = async (url, opts) => { seen = { url, opts }; return { ok: true }; };
    assert.deepStrictEqual(await purgeCacheTags('product-overrides'), { purged: true });
    assert.strictEqual(seen.url, 'https://api.netlify.com/api/v1/purge');
    assert.strictEqual(seen.opts.headers.Authorization, 'Bearer tok');
    assert.deepStrictEqual(JSON.parse(seen.opts.body), { site_id: 'site-123', cache_tags: ['product-overrides'] });
  });
});

test('a rejected or throwing purge is reported, never thrown', async () => {
  await withEnv({ SITE_ID: 's', NETLIFY_PURGE_API_TOKEN: 't' }, async () => {
    global.fetch = async () => ({ ok: false, status: 503 });
    assert.deepStrictEqual(await purgeCacheTags(['x']), { purged: false, reason: 'http-503' });
    global.fetch = async () => { throw new Error('socket hang up'); };
    assert.deepStrictEqual(await purgeCacheTags(['x']), { purged: false, reason: 'socket hang up' });
  });
});
