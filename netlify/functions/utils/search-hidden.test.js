const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// In-memory stand-in for the `catalog` blob store.
const blobs = new Map();
let failReads = false;
const realLoad = Module._load;
Module._load = function (id, ...rest) {
  if (id === '@netlify/blobs') return {
    getStore: (name) => ({
      get: async (key) => { if (failReads) throw new Error('kv down'); return blobs.get(`${name}:${key}`) ?? null; },
      setJSON: async (key, v) => { blobs.set(`${name}:${key}`, JSON.parse(JSON.stringify(v))); },
    }),
  };
  return realLoad.call(this, id, ...rest);
};
const H = require('./search-hidden');
Module._load = realLoad;

beforeEach(() => { blobs.clear(); failReads = false; });

test('normSlug accepts a slug, a product path or a full URL', () => {
  assert.equal(H.normSlug('The-Alchemist'), 'the-alchemist');
  assert.equal(H.normSlug('/product/the-alchemist/'), 'the-alchemist');
  assert.equal(H.normSlug('https://inkandchai.in/product/the-alchemist/?utm=x'), 'the-alchemist');
  assert.equal(H.normSlug('  '), '');
});

test('setHidden turns hiding on and off and keeps one row per slug', async () => {
  await H.setHidden('/product/a/', true, { title: 'A' });
  await H.setHidden('b', true, { title: 'B' });
  await H.setHidden('a', true, { title: 'A again' });
  let items = await H.readHidden();
  assert.deepEqual(items.map((i) => i.slug), ['a', 'b']);
  assert.equal(items[0].title, 'A again');
  await H.setHidden('a', false);
  items = await H.readHidden();
  assert.deepEqual(items.map((i) => i.slug), ['b']);
  assert.deepEqual([...await H.hiddenSlugSet()], ['b']);
  await assert.rejects(H.setHidden('', true), /Missing product slug/);
});

test('unsearchableSlugSet merges deleted and hidden slugs', async () => {
  const deleted = new Set(['gone']);
  await H.setHidden('a', false); // empty list
  assert.equal(await H.unsearchableSlugSet(deleted), deleted);
  await H.setHidden('hid', true);
  assert.deepEqual([...await H.unsearchableSlugSet(deleted)].sort(), ['gone', 'hid']);
});

test('a storage failure keeps the last good set instead of breaking search', async () => {
  await H.setHidden('hid', true);
  failReads = true;
  const real = Date.now;
  Date.now = () => real() + 120_000; // past the cache window
  try {
    assert.deepEqual([...await H.hiddenSlugSet()], ['hid']);
  } finally { Date.now = real; }
});
