'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./product-sample');

test('keys are minted per product and only accepted for that product', () => {
  const key = S.newSampleKey('the-alchemist', 1759300000000, 'ab12cd');
  assert.equal(key, 'samples/the-alchemist-1759300000000-ab12cd.pdf');
  assert.equal(S.isSampleKeyFor(key, 'the-alchemist'), true);
  assert.equal(S.isSampleKeyFor(key, 'the-alchemist-hindi'), false);
  assert.equal(S.isSampleKeyFor('samples/the-alchemist-hindi-1759300000000-ab12cd.pdf', 'the-alchemist'), false);
  assert.equal(S.isSampleKeyFor('videos/the-alchemist-1759300000000-ab12cd.pdf', 'the-alchemist'), false);
  assert.equal(S.isSampleKeyFor('samples/../ebooks/x.pdf', 'x'), false);
  assert.equal(S.isSampleKeyFor(key, ''), false);
});

test('pages must be 1-60', () => {
  assert.equal(S.cleanPages('20'), 20);
  assert.equal(S.cleanPages(0), null);
  assert.equal(S.cleanPages(61), null);
  assert.equal(S.cleanPages('x'), null);
});

test('the public view hides the storage key and versions the file URL', () => {
  const pub = S.publicSample({ slug: 'a-b', r2_key: 'samples/a-b-1-x.pdf', pages: 12, updated_at: '2026-10-01T00:00:00Z' });
  assert.equal(pub.pages, 12);
  assert.equal(pub.file_url, `/.netlify/functions/get-product-sample?slug=a-b&file=pdf&v=${Date.parse('2026-10-01T00:00:00Z')}`);
  assert.equal(JSON.stringify(pub).includes('r2_key'), false);
  assert.equal(S.publicSample(null), null);
});

test('a missing table is recognised', () => {
  assert.equal(S.isMissingTable({ message: 'relation "public.product_samples" does not exist' }), true);
  assert.equal(S.isMissingTable({ message: "Could not find the table 'public.product_samples' in the schema cache" }), true);
  assert.equal(S.isMissingTable({ message: 'timeout' }), false);
});

// ── Handlers, with Supabase stubbed ─────────────────────────────────────────
const ROWS = {};
const sbPath = require.resolve('@supabase/supabase-js');
require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: {
  createClient: () => ({ from() {
    const q = { slug: null, op: 'select', row: null };
    q.select = () => q; q.single = () => q; q.maybeSingle = () => q;
    q.eq = (_c, v) => { q.slug = v; return q; };
    q.upsert = (row) => { q.op = 'upsert'; q.row = row; return q; };
    q.delete = () => { q.op = 'delete'; return q; };
    q.then = (res, rej) => {
      let out;
      if (q.op === 'upsert') { ROWS[q.row.slug] = q.row; out = { data: q.row, error: null }; }
      else if (q.op === 'delete') { delete ROWS[q.slug]; out = { data: null, error: null }; }
      else out = { data: ROWS[q.slug] || null, error: null };
      return Promise.resolve(out).then(res, rej);
    };
    return q;
  } }),
} };

test.before(() => {
  process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-secret';
  process.env.SUPABASE_URL = 'https://x.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'k';
});

const admin = (body) => require('../admin-product-sample').handler({
  httpMethod: 'POST', path: '/.netlify/functions/admin-product-sample',
  headers: { 'x-admin-key': process.env.ADMIN_SECRET }, body: JSON.stringify(body),
});

test('admin endpoint needs an admin', async () => {
  const res = await require('../admin-product-sample').handler({ httpMethod: 'POST', path: '/.netlify/functions/admin-product-sample', headers: {}, body: '{}' });
  assert.equal(res.statusCode, 401);
});

test('save refuses a key minted for another product', async () => {
  const res = await admin({ action: 'save', slug: 'book-a', key: 'samples/book-b-1759300000000-ab12cd.pdf', pages: 10 });
  assert.equal(res.statusCode, 400);
  assert.equal(ROWS['book-a'], undefined);
});

test('the storefront sees nothing for a book without a sample, and the sample once saved', async () => {
  const get = require('../get-product-sample').handler;
  const none = JSON.parse((await get({ httpMethod: 'GET', queryStringParameters: { slug: 'book-c' } })).body);
  assert.equal(none.sample, null);
  ROWS['book-c'] = { slug: 'book-c', r2_key: 'samples/book-c-1759300000000-ab12cd.pdf', pages: 15, updated_at: '2026-10-01T00:00:00Z' };
  const some = JSON.parse((await get({ httpMethod: 'GET', queryStringParameters: { slug: 'book-c' } })).body);
  assert.equal(some.sample.pages, 15);
  assert.match(some.sample.file_url, /file=pdf/);
  const gone = await admin({ action: 'remove', slug: 'book-c' });
  assert.equal(gone.statusCode, 200);
  assert.equal(ROWS['book-c'], undefined);
});
