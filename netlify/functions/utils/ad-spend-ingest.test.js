'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AD_SPEND_KEY = 'k'.repeat(32);
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_KEY = 'x';
const { handler } = require('../ad-spend-ingest');

const post = (body, key) => handler({ httpMethod: 'POST', headers: key ? { 'x-ad-spend-key': key } : {}, body: JSON.stringify(body) });

test('the Google Ads script must carry the key', async () => {
  assert.equal((await post({ platform: 'google' })).statusCode, 401);
  assert.equal((await post({ platform: 'google' }, 'k'.repeat(31) + 'j')).statusCode, 401);
});

test('Meta, foreign currencies and bad rows are refused before any write', async () => {
  const key = 'k'.repeat(32);
  assert.equal((await post({ platform: 'meta', account: '1', rows: [{ date: '2026-10-19', cost: 1 }] }, key)).statusCode, 400);
  const usd = await post({ platform: 'google', account: '1', currency: 'USD', rows: [{ date: '2026-10-19', cost: 1 }] }, key);
  assert.equal(usd.statusCode, 400);
  assert.match(JSON.parse(usd.body).error, /USD/);
  assert.equal((await post({ platform: 'google', account: '1', rows: [{ date: 'x', cost: 1 }] }, key)).statusCode, 400);
});
