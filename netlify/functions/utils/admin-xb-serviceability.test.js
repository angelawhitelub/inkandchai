'use strict';

// The NimbusPost push dialog's check: held orders are counted apart from the
// ready ones, and booked rows say which courier has them.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-admin-key';
process.env.XPRESSBEES_PICKUP_PINCODE = '110006';
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_KEY = 'x';

const base = (id, over = {}) => ({
  id: id.toLowerCase(), razorpay_order_id: id, status: 'paid', created_at: new Date().toISOString(),
  customer_address: 'House 1, Mumbai 400001', amount_paise: 49900, razorpay_payment_id: 'pay_1',
  cart_items: [{ slug: 'plain', title: 'Plain', qty: 1, price: 499 }], ...over,
});
const ROWS = [
  base('IC-READY'),
  base('IC-NOSVC', { customer_address: 'House 2, Nowhere 999999' }),
  base('IC-HELD', { cart_items: [{ slug: 'slow', title: 'Slow Book', qty: 1, price: 499, _handling_days: 20 }] }),
  base('IC-PRE', { cart_items: [{ slug: 'soon', title: 'Soon', qty: 1, price: 499, _release: '2099-11-20' }] }),
  base('IC-AWB', { tracking_id: '2173000000001', courier_name: 'Delhivery', last_courier_status: 'Delivered' }),
];

function fakeDb(rows) {
  return {
    from: (table) => {
      const b = {
        select: () => b, eq: () => b, is: () => b, in: () => b, gte: () => b, lt: () => b, gt: () => b, not: () => b,
        order: () => b, limit: () => b, or: () => b,
        // Book settings unreadable here: the stamps on the order lines decide.
        range: async () => ({ data: null, error: { message: 'books unavailable in this test' } }),
        then: (ok, bad) => Promise.resolve({ data: table === 'orders' ? rows : [], error: null }).then(ok, bad),
      };
      return b;
    },
  };
}

test('held orders are counted apart; booked rows carry courier and scan', async () => {
  const sbPath = require.resolve('@supabase/supabase-js');
  const saved = require.cache[sbPath];
  require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: { createClient: () => fakeDb(ROWS) } };
  const xb = require('./xpressbees');
  const realSvc = xb.serviceability;
  xb.serviceability = async ({ destination }) => {
    if (destination === '999999') throw new Error('Pincode not serviceable');
    return [{ id: 1 }];
  };
  const fn = path.join(__dirname, '..', 'admin-xb-serviceability.js');
  delete require.cache[fn];
  try {
    const { handler } = require(fn);
    const res = await handler({ httpMethod: 'POST', headers: { 'x-admin-key': process.env.ADMIN_SECRET }, body: '{}' });
    assert.equal(res.statusCode, 200, res.body);
    const out = JSON.parse(res.body);
    const by = Object.fromEntries(out.orders.map((o) => [o.order, o]));
    assert.equal(out.counts.serviceable, 1);
    assert.equal(out.counts.not_serviceable, 1);
    assert.equal(out.counts.held, 2);
    assert.equal(out.counts.held_handling, 1);
    assert.equal(out.counts.held_preorder, 1);
    assert.equal(out.counts.booked, 1);
    assert.equal(by['IC-HELD'].held.kind, 'handling');
    assert.equal(by['IC-HELD'].serviceable, true, 'held orders are still checked, for "push anyway"');
    assert.equal(by['IC-PRE'].held.kind, 'preorder');
    assert.equal(by['IC-READY'].held, undefined);
    assert.equal(by['IC-AWB'].courier, 'Delhivery');
    assert.equal(by['IC-AWB'].scan, 'Delivered');
    assert.equal(by['IC-AWB'].awb, '2173000000001');
  } finally {
    xb.serviceability = realSvc;
    if (saved) require.cache[sbPath] = saved; else delete require.cache[sbPath];
    delete require.cache[fn];
  }
});
