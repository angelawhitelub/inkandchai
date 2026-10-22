'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.invalid';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';
const { handler } = require('../update-order-address');

const post = (address) => handler({ httpMethod: 'POST', body: JSON.stringify({ id: 'IC-X', q: '9999999999', address }) });

test('an address change without a pincode is refused before the order is touched', async () => {
  // IC-20261006-QPV2H: a checkout address with a pincode was replaced by this.
  const r = await post('Gym knight  krishna colony hodal');
  assert.equal(r.statusCode, 400);
  assert.equal(JSON.parse(r.body).code, 'missing_pincode');
});

test('a junk pincode is refused like at checkout', async () => {
  const r = await post('Gym knight, krishna colony, Hodal, Haryana 123456');
  assert.equal(r.statusCode, 400);
  assert.equal(JSON.parse(r.body).code, 'invalid_pincode');
});

test('a phone number is not mistaken for a pincode', async () => {
  const r = await post('Gym knight krishna colony hodal, call 9996949289');
  assert.equal(JSON.parse(r.body).code, 'missing_pincode');
});
