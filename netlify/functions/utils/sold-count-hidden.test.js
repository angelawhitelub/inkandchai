const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('fs');
const path = require('path');

// In-memory `catalog` blob store, kept stubbed for the whole file (lifetime-sales
// requires @netlify/blobs lazily).
const blobs = new Map();
const realLoad = Module._load;
Module._load = function (id, ...rest) {
  if (id === '@netlify/blobs') return {
    getStore: (name) => ({
      get: async (key) => blobs.get(`${name}:${key}`) ?? null,
      setJSON: async (key, v) => { blobs.set(`${name}:${key}`, JSON.parse(JSON.stringify(v))); },
    }),
  };
  if (id === './utils/purge-cache') return { purgeCacheTags: async () => ({ purged: false }), purgeUrls: async (u) => { purged.push(...u); return { purged: true }; } };
  if (id === './utils/admin-auth') return { requireAdmin: () => null };
  return realLoad.call(this, id, ...rest);
};
const purged = [];
const H = require('./search-hidden');
const soldCounts = require('../sold-counts').handler;
const admin = require('../admin-search-hidden').handler;

test('hiding a sold count drops it from sold-counts only, and the search/browse lists are untouched', async () => {
  blobs.set('catalog:lifetime-sales', { counts: { 'loved-book': 120, 'quiet-book': 45 } });
  const post = (body) => admin({ httpMethod: 'POST', body: JSON.stringify(body) }).then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }));
  const r = await post({ slug: '/product/quiet-book/', hidden: true, title: 'Quiet Book', scope: 'sold' });
  assert.equal(r.status, 200);
  assert.equal(r.body.hidden, true);
  assert.ok(purged.some((u) => u.endsWith('/.netlify/functions/sold-counts')));
  const counts = JSON.parse((await soldCounts()).body).counts;
  assert.deepEqual(counts, { 'loved-book': 120 });
  assert.deepEqual(await H.readHidden(), []);
  assert.deepEqual(await H.browse.readHidden(), []);
  const one = await admin({ httpMethod: 'GET', queryStringParameters: { scope: 'sold', slug: 'quiet-book' } });
  assert.equal(JSON.parse(one.body).hidden, true);
  await post({ slug: 'quiet-book', hidden: false, scope: 'sold' });
  assert.equal((await H.sold.readHidden()).length, 0);
});

test('the product page skips the bought line, badge and rank row for a hidden book', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../../worker/index.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function withSoldCount'), src.indexOf('function gonePage'));
  assert.match(fn, /searchHidden\.sold\.hiddenSlugSet\(\)/);
  assert.match(fn, /const line = countHidden \? '' :/);
  assert.match(fn, /const rank = countHidden \? null :/);
  const page = src.slice(src.indexOf('async function bestsellersPage'), src.indexOf('const ARRIVALS_TTL_MS'));
  assert.match(page, /noRank: await searchHidden\.sold\.hiddenSlugSet\(\)/);
});

test('the Best Sellers page keeps a hidden book but drops its #N', () => {
  const R = require('./bestseller-rank');
  const bsr = { order: ['a', 'b'], ranks: { a: [1, 'romance', 1], b: [2, 'romance', 2] }, info: { a: { title: 'A' }, b: { title: 'B' } }, shelves: { romance: 'Romance' } };
  const html = R.pageParts(bsr, '', { noRank: new Set(['a']) }).cards;
  assert.ok(html.includes('>A<') && html.includes('>B<'));
  assert.ok(!html.includes('#1<'));
  assert.ok(html.includes('#2<'));
});
