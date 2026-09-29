const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const FN = path.join(__dirname, '..', 'courier-cancel-shipment.js');
const SUPA = require.resolve('@supabase/supabase-js');

function load(row, courierResult) {
  const calls = [];
  const stub = (rel, exports) => {
    const file = require.resolve(path.join(__dirname, '..', rel));
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  };
  delete require.cache[FN];
  require.cache[SUPA] = { id: SUPA, filename: SUPA, loaded: true, exports: { createClient: () => ({
    from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: row, error: null }) }; return q; },
  }) } };
  stub('utils/admin-auth.js', { requireAdmin: () => null });
  stub('utils/courier-shipment-cancel.js', {
    cancelCourierShipment: async (o) => { calls.push(o.tracking_id); return courierResult; },
    recordCourierCancel: async () => {},
  });
  process.env.SUPABASE_URL = 'https://stub.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'stub';
  const handler = require(FN).handler;
  return { calls, run: () => handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ id: 'IC-20260923-XB3M7' }) })
    .then(r => ({ statusCode: r.statusCode, ...JSON.parse(r.body) })) };
}

test('stops the AWB of an order already cancelled here', async () => {
  const { run, calls } = load({ id: 'u', razorpay_order_id: 'IC-20260923-XB3M7', status: 'cancelled', tracking_id: '14345160618943', courier_name: 'Xpressbees' },
    { action: 'cancelled', message: 'XpressBees shipment 14345160618943 cancelled.' });
  const r = await run();
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['14345160618943']);
});

test('reports, not hides, a parcel already moving', async () => {
  const { run } = load({ id: 'u', status: 'cancelled', tracking_id: '1', courier_name: 'Xpressbees' }, { action: 'moving', message: 'too late' });
  const r = await run();
  assert.equal(r.statusCode, 200);
  assert.equal(r.ok, false);
  assert.equal(r.courier.action, 'moving');
});

test('never touches a live order or one without an AWB', async () => {
  const live = load({ id: 'u', status: 'shipped', tracking_id: '1' }, { action: 'cancelled' });
  assert.equal((await live.run()).statusCode, 400);
  assert.equal(live.calls.length, 0);
  const noAwb = load({ id: 'u', status: 'cancelled', tracking_id: null }, { action: 'cancelled' });
  assert.equal((await noAwb.run()).statusCode, 400);
  assert.equal(noAwb.calls.length, 0);
});
