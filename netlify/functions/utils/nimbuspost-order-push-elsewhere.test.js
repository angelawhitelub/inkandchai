'use strict';

// "Push to NimbusPost" must leave alone an order another courier already has
// (IC-20260914-9VP7A shipped three times that way), unless the admin forces
// that one named order after being warned.

const test = require('node:test');
const assert = require('node:assert/strict');

const base = {
  status: 'paid', customer_name: 'Asha Rao', customer_phone: '9876543210', customer_email: 'a@example.com',
  customer_address: '12, MG Road, Indiranagar, Bengaluru, Karnataka 560038',
  amount_paise: 29900, razorpay_payment_id: 'OMO1', cart_items: [{ title: 'Some Book', qty: 1, price: 299 }],
};
const ORDERS = [
  { ...base, id: 'a', razorpay_order_id: 'IC-FRESH' },
  { ...base, id: 'b', razorpay_order_id: 'IC-ITHINK', ithink_pushed_at: '2026-09-14T10:00:00Z' },
  { ...base, id: 'c', razorpay_order_id: 'IC-XB', xpressbees_feed_at: '2026-09-14T10:00:00Z' },
];

// Stub supabase before the handler loads it.
const sbPath = require.resolve('@supabase/supabase-js');
require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: {
  createClient: () => ({ from() {
    const q = { ids: null };
    q.select = () => q; q.or = () => q; q.order = () => q; q.limit = () => q; q.eq = () => q;
    q.in = (col, vals) => { if (col === 'razorpay_order_id') q.ids = vals; return q; };
    q.update = () => q;
    q.then = (res, rej) => Promise.resolve({
      data: q.ids ? ORDERS.filter(o => q.ids.includes(o.razorpay_order_id)) : ORDERS, error: null,
    }).then(res, rej);
    return q;
  } }),
} };

const { handler } = require('../nimbuspost-order-push');

function withFakeFetch(fn) {
  const created = [];
  const real = global.fetch;
  global.fetch = async (url, opts = {}) => {
    if (/orders\/create/.test(url)) {
      // The create call posts a form; the order number is all this test needs.
      const b = opts.body;
      created.push(b && typeof b.get === 'function' ? b.get('order_number') : String(b));
      return { ok: true, status: 200, json: async () => ({ status: true }), text: async () => '{"status":true}' };
    }
    return { ok: true, status: 200, json: async () => ({ status: true, data: [] }), text: async () => '{"status":true,"data":[]}' };
  };
  return fn(created).finally(() => { global.fetch = real; });
}

const call = (body) => handler({
  httpMethod: 'POST', path: '/.netlify/functions/nimbuspost-order-push',
  headers: { 'x-admin-key': process.env.ADMIN_SECRET }, body: JSON.stringify(body),
});

test.before(() => {
  process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-secret';
  process.env.NIMBUSPOST_API_KEY = 'test-key';
});

test('push-all skips orders booked with iThink or queued for XpressBees', () => withFakeFetch(async (created) => {
  const res = await call({ all_unshipped: true, include_booked_elsewhere: true });
  const { summary } = JSON.parse(res.body);
  assert.equal(summary.pushed, 1);
  assert.equal(created.length, 1);
  assert.deepEqual(summary.booked_elsewhere.map(s => s.split(':')[0]).sort(), ['IC-ITHINK', 'IC-XB']);
}));

test('a named order is refused until forced, then pushed', () => withFakeFetch(async (created) => {
  const first = JSON.parse((await call({ order_ids: ['IC-ITHINK'] })).body).summary;
  assert.equal(first.pushed, 0);
  assert.match(first.booked_elsewhere[0], /iThink/);
  assert.equal(created.length, 0);
  const forced = JSON.parse((await call({ order_ids: ['IC-ITHINK'], include_booked_elsewhere: true })).body).summary;
  assert.equal(forced.pushed, 1);
}));
