/**
 * The status code product-page returns IS the product's fate in Merchant
 * Center: a 404 disapproves the listing, a 503 is retried. These tests pin the
 * distinction that cost 175 listings on 24 Aug 2026.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const supaPath = require.resolve('@supabase/supabase-js');
let nextResult = null;   // what .single() resolves to

require.cache[supaPath] = {
  id: supaPath, filename: supaPath, loaded: true, exports: {
    createClient: () => ({
      from: () => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          single: async () => {
            if (typeof nextResult === 'function') return nextResult();
            return nextResult;
          },
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return chain;
      },
    }),
  },
};

process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'stub';

const { handler } = require('../../netlify/functions/product-page.js');
const call = (slug) => handler({ queryStringParameters: { slug }, path: `/product/${slug}/` });

test('a slug that does not exist is a genuine 404', async () => {
  nextResult = { data: null, error: { code: 'PGRST116', message: 'no rows' } };
  const res = await call('no-such-book');
  assert.equal(res.statusCode, 404);
});

test('an unreachable database is 503, never 404', async () => {
  nextResult = () => { throw new Error('getaddrinfo ENOTFOUND lajjjjkidxyfvmnyjboy.supabase.co'); };
  const res = await call('the-hidden-hindu-akshat-gupta');
  assert.equal(res.statusCode, 503, 'a 404 here delists a product that is perfectly fine');
  assert.equal(res.headers['Retry-After'], '600');
  assert.equal(res.headers['Cache-Control'], 'no-store', 'an outage must not be cached');
});

test('a database error that is not "no rows" is 503', async () => {
  nextResult = { data: null, error: { code: '57P01', message: 'server closed the connection' } };
  const res = await call('some-book');
  assert.equal(res.statusCode, 503);
});

test('a healthy lookup still renders the product', async () => {
  nextResult = {
    data: { slug: 'x', title: 'A Book', author: 'Someone', price_inr: 299,
            image_url: 'https://img/x.jpg', is_active: true },
    error: null,
  };
  const res = await call('x');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /A Book/);
});

test('missing credentials are our fault, not a missing product', async () => {
  const url = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  const res = await call('x');
  process.env.SUPABASE_URL = url;
  assert.equal(res.statusCode, 503);
});

test('an empty slug is still a 404', async () => {
  const res = await handler({ queryStringParameters: { slug: '' }, path: '/product/' });
  assert.equal(res.statusCode, 404);
});
