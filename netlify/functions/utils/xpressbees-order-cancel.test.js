'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Our orders, served to the handler through a stubbed Supabase client.
const OURS = [
  { razorpay_order_id: 'IC-20261006-VMX7Z', status: 'cancelled', tracking_id: null },
  { razorpay_order_id: 'IC-CW-20261001-VBLER', status: 'refunded', tracking_id: null },
  { razorpay_order_id: 'IC-20261007-SHIPD', status: 'shipped', tracking_id: '7D1', courier_name: 'DTDC' },
  { razorpay_order_id: 'IC-20261007-CXAWB', status: 'cancelled', tracking_id: '14344' },
  { razorpay_order_id: 'IC-20261008-OPEN1', status: 'paid', tracking_id: null },
  { razorpay_order_id: 'IC-20261005-BOOKD', status: 'cancelled', tracking_id: null },
];
const PANEL = [
  { id: 1, order_number: 'IC-20261006-VMX7Z', status: 'new', awb_numbers: '' },
  { id: 2, order_number: 'IC-CW-20261001-VBLER', status: 'new', awb_numbers: '' },
  { id: 3, order_number: 'IC-20261007-SHIPD', status: 'new', awb_numbers: '' },
  { id: 4, order_number: 'IC-20261007-CXAWB', status: 'new', awb_numbers: '' },
  { id: 5, order_number: 'IC-20261008-OPEN1', status: 'new', awb_numbers: '' },
  { id: 6, order_number: 'IC-20261005-BOOKD', status: 'booked', awb_numbers: '' },
];

function stubSupabase() {
  const q = (rows) => {
    const self = {
      select: () => self, eq: () => self, not: () => self, gte: () => self, lt: () => self,
      in: (c, ids) => q(rows.filter((r) => ids.includes(r.razorpay_order_id))),
      limit: () => Promise.resolve({ data: rows, error: null }),
      then: (ok, bad) => Promise.resolve({ data: rows, error: null }).then(ok, bad),
    };
    return self;
  };
  const file = require.resolve('@supabase/supabase-js');
  require.cache[file] = { id: file, filename: file, loaded: true, exports: { createClient: () => ({ from: () => q(OURS) }) } };
}

stubSupabase();
process.env.ADMIN_SECRET = 'test-secret';
const xb = require('./xpressbees');
xb.panelOrders = async ({ params }) => {
  if (params.page_no !== '1') throw new Error('No data Found.');
  return { rows: PANEL };
};
const posted = [];
xb.withAuth = async (fn) => fn('tok');
global.fetch = async (url, opts) => { posted.push(String(opts.body)); return { status: 200, text: async () => '{"status":true,"message":"Order Cancelled"}' }; };
const { handler } = require(path.join('..', 'xpressbees-order-cancel'));

const call = (body) => handler({ httpMethod: 'POST', headers: { 'x-admin-key': 'test-secret' }, body: JSON.stringify(body) })
  .then((r) => ({ status: r.statusCode, ...JSON.parse(r.body) }));

test('closed_here clears queued rows of cancelled/refunded orders that never got an AWB', async () => {
  const r = await call({ dry_run: true, any_courier: true, closed_here: true });
  assert.equal(r.status, 200);
  const plan = Object.fromEntries(r.plan.map((p) => [p.order, p.reason]));
  assert.deepEqual(plan, {
    'IC-20261006-VMX7Z': 'closed_here',
    'IC-CW-20261001-VBLER': 'closed_here',
    'IC-20261007-SHIPD': 'carried_elsewhere',
  });
  // A cancelled order with an AWB is reported, an open order is untouched,
  // and a booked row is never cancelled.
  assert.deepEqual(r.left_alone.cancelled_here, ['IC-20261007-CXAWB']);
  assert.ok(r.left_alone.not_shipped_here.includes('IC-20261008-OPEN1'));
  assert.equal(r.skipped.booked[0].order, 'IC-20261005-BOOKD');
});

test('without closed_here the old behaviour stands', async () => {
  const r = await call({ dry_run: true, any_courier: true });
  assert.deepEqual(r.plan.map((p) => p.order), ['IC-20261007-SHIPD']);
  assert.ok(r.left_alone.cancelled_here.includes('IC-20261006-VMX7Z'));
});

test('an explicit order list may name closed orders, and cancels one form-encoded id per call', async () => {
  posted.length = 0;
  const r = await call({ dry_run: false, any_courier: true, closed_here: true, order_ids: ['IC-20261006-VMX7Z', 'IC-CW-20261001-VBLER'] });
  assert.equal(r.status, 200);
  assert.equal(r.results.length, 2);
  assert.ok(r.results.every((x) => x.ok));
  assert.deepEqual(posted, ['id=1', 'id=2']);
});
