'use strict';

// request-reviews: a send WhatsApp refused is a failure, and is not stamped as asked.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-admin-key';
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_KEY = 'x';

const delivered = (n) => Array.from({ length: n }, (_, i) => ({
  id: 'row' + i, razorpay_order_id: 'IC-20261101-A' + String(i).padStart(4, '0'),
  customer_name: 'Reader ' + i, customer_phone: '98' + String(10000000 + i), cart_items: [{ title: 'Book' }],
  delivered_at: new Date().toISOString(), review_requested_at: null,
}));

function run(sendImpl, rows) {
  const updates = [];
  const db = {
    from: () => {
      const b = {
        select: () => b, eq: () => b, gte: () => b, is: () => b, order: () => b, limit: async () => ({ data: rows, error: null }),
        update: (patch) => { updates.push(patch); return { in: () => Promise.resolve({ error: null }) }; },
      };
      return b;
    },
  };
  const sbPath = require.resolve('@supabase/supabase-js');
  const waPath = require.resolve('./whatsapp');
  const saved = [require.cache[sbPath], require.cache[waPath]];
  const realWa = require('./whatsapp');
  require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: { createClient: () => db } };
  require.cache[waPath] = { id: waPath, filename: waPath, loaded: true, exports: { ...realWa, sendWhatsApp: sendImpl } };
  const fn = path.join(__dirname, '..', 'request-reviews.js');
  delete require.cache[fn];
  const { handler } = require(fn);
  const restore = () => {
    if (saved[0]) require.cache[sbPath] = saved[0]; else delete require.cache[sbPath];
    require.cache[waPath] = saved[1];
    delete require.cache[fn];
  };
  return handler({ httpMethod: 'POST', headers: { 'x-admin-key': process.env.ADMIN_SECRET }, body: JSON.stringify({ days_back: 21, limit: 300 }) })
    .then((res) => ({ res, body: JSON.parse(res.body), updates }))
    .finally(restore);
}

test('Meta refusing the template: nothing counted as sent, nobody stamped, run stops early', async () => {
  let calls = 0;
  const refuse = async () => { calls += 1; return { ok: false, status: 400, data: { error: { code: 132001, message: 'Template name does not exist in the translation' } } }; };
  const { body, updates } = await run(refuse, delivered(45));
  assert.equal(body.sent, 0);
  assert.equal(body.failed, 20, 'first batch only');
  assert.equal(body.aborted, true);
  assert.equal(body.not_tried, 25);
  assert.equal(body.success, false);
  assert.equal(calls, 20);
  assert.deepEqual(updates, [], 'no review_requested_at stamp');
  assert.match(Object.keys(body.reasons)[0], /code 132001/);
});

test('accepted sends are stamped; a refused one is not', async () => {
  let n = 0;
  const mixed = async () => { n += 1; return n === 2 ? { ok: false, status: 400, data: { error: { code: 131026, message: 'Message undeliverable' } } } : { ok: true, status: 200, data: {} }; };
  const { body, updates } = await run(mixed, delivered(3));
  assert.equal(body.sent, 2);
  assert.equal(body.failed, 1);
  assert.equal(body.success, true);
  assert.equal(updates.length, 1, 'one stamp update for the accepted rows');
});
