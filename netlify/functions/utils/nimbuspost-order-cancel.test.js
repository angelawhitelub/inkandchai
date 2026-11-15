'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { cancelNimbusOrderForGood, withNimbus, classify } = require('./nimbuspost-order-cancel');

// A fake NimbusPost v2: GET /v2/orders filters by awb / order_number, POST
// /v2/orders/{id}/cancel records the call and answers per `refuse`.
function fakeNp(rows, { refuse = {} } = {}) {
  const calls = { cancels: [], bodies: [] };
  const v2Fetch = async (path, opts = {}) => {
    const u = new URL('https://x' + path);
    if (u.pathname === '/v2/orders' && (opts.method || 'GET') === 'GET') {
      const awb = u.searchParams.get('awb');
      const nums = (u.searchParams.get('order_number') || '').split(',').filter(Boolean);
      const data = rows.filter((r) => (awb ? String(r.shipment?.awb || '') === awb : true)
        && (nums.length ? nums.includes(r.order_number) : true));
      return { httpStatus: 200, data: { success: true, data, meta: { pagination: {} } } };
    }
    const m = u.pathname.match(/^\/v2\/orders\/([^/]+)\/cancel$/);
    if (m && opts.method === 'POST') {
      calls.cancels.push(decodeURIComponent(m[1]));
      calls.bodies.push(opts.body);
      const no = refuse[m[1]];
      if (no) return { httpStatus: 400, data: { success: false, error: { code: no, message: 'This order has already been picked up and cannot be cancelled.' } } };
      return { httpStatus: 200, data: { success: true, data: { order_id: m[1], order_status: 'cancelled', cancelled: true } } };
    }
    return { httpStatus: 404, data: null, raw: 'unexpected ' + path };
  };
  return { v2Fetch, calls };
}

test('cancels the ORDER (scope "order"), not just the shipment, and every re-push of it', async () => {
  const { v2Fetch, calls } = fakeNp([
    { order_id: 'NP1', order_number: 'IC-20261110-S2XH3', order_status: 'cancelled', shipment: { awb: '40441751791363' } },
    { order_id: 'NP2', order_number: 'IC-20261110-S2XH3-c', order_status: 'booked', shipment: { awb: '40441752046432' } },
    { order_id: 'NP3', order_number: 'IC-20261110-OTHER', order_status: 'booked', shipment: { awb: '1' } },
  ]);
  const r = await cancelNimbusOrderForGood({ orderNumber: 'IC-20261110-S2XH3' }, { v2Fetch });
  assert.equal(r.handled, true);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.cancels, ['NP2']);
  assert.equal(calls.bodies[0].scope, 'order');
  assert.deepEqual(r.already.map((x) => x.order_id), ['NP1']);
});

test('from an AWB it finds the order behind it and its siblings under the same number', async () => {
  const { v2Fetch, calls } = fakeNp([
    { order_id: 'A', order_number: 'IC-20261109-VB6VW', order_status: 'created', shipment: null },
    { order_id: 'B', order_number: 'IC-20261109-VB6VW-C', order_status: 'pickup_scheduled', shipment: { awb: '236454102635966' } },
  ]);
  const r = await cancelNimbusOrderForGood({ awb: '236454102635966' }, { v2Fetch });
  assert.deepEqual(calls.cancels.sort(), ['A', 'B']);
  assert.equal(r.ok, true);
});

test('siblings:false (stray-AWB tool) cancels only the order behind that AWB', async () => {
  const { v2Fetch, calls } = fakeNp([
    { order_id: 'LIVE', order_number: 'IC-1', order_status: 'booked', shipment: { awb: 'KEEP' } },
    { order_id: 'STRAY', order_number: 'IC-1-c', order_status: 'booked', shipment: { awb: 'STRAYAWB' } },
  ]);
  await cancelNimbusOrderForGood({ awb: 'STRAYAWB', siblings: false }, { v2Fetch });
  assert.deepEqual(calls.cancels, ['STRAY']);
});

test('a picked-up parcel is never cancelled blind; it is reported for an RTO', async () => {
  const { v2Fetch, calls } = fakeNp([
    { order_id: 'T', order_number: 'IC-20261110-1GWBK', order_status: 'in_transit', shipment: { awb: '7D130603828' } },
    { order_id: 'U', order_number: 'IC-20261110-1GWBK-c', order_status: 'weird_new_state', shipment: { awb: 'x' } },
  ]);
  const r = await cancelNimbusOrderForGood({ orderNumber: 'IC-20261110-1GWBK' }, { v2Fetch });
  assert.deepEqual(calls.cancels, []);
  assert.equal(r.ok, false);
  assert.equal(r.moving.length, 2);
  assert.match(r.message, /RTO/);
});

test('NimbusPost refusing because it was picked up meanwhile counts as moving, not failed', async () => {
  const { v2Fetch } = fakeNp([{ order_id: 'P', order_number: 'IC-2', order_status: 'booked', shipment: { awb: 'p' } }],
    { refuse: { P: 'ORDER_NOT_CANCELLABLE' } });
  const r = await cancelNimbusOrderForGood({ orderNumber: 'IC-2' }, { v2Fetch });
  assert.equal(r.moving.length, 1);
  assert.equal(r.failed.length, 0);
});

test('unknown to NimbusPost or no v2 key: not handled, so callers fall back', async () => {
  const { v2Fetch } = fakeNp([]);
  assert.equal((await cancelNimbusOrderForGood({ orderNumber: 'IC-404' }, { v2Fetch })).handled, false);
  const saved = [process.env.NIMBUSPOST_V2_API_KEY, process.env.NIMBUSPOST_V2_API_SECRET];
  delete process.env.NIMBUSPOST_V2_API_KEY; delete process.env.NIMBUSPOST_V2_API_SECRET;
  assert.equal((await cancelNimbusOrderForGood({ orderNumber: 'IC-1' })).handled, false);
  if (saved[0]) process.env.NIMBUSPOST_V2_API_KEY = saved[0];
  if (saved[1]) process.env.NIMBUSPOST_V2_API_SECRET = saved[1];
});

test('lifecycle: before-pickup states are cancellable, closed ones already done', () => {
  for (const s of ['created', 'booked', 'pickup_scheduled', 'pickup_pending', 'out_for_pickup', 'pickup_failed', 'ready_to_ship'])
    assert.equal(classify({ order_status: s }), 'cancel', s);
  for (const s of ['cancelled', 'lost', 'rto_damaged']) assert.equal(classify({ order_status: s }), 'already', s);
  for (const s of ['pickup_completed', 'in_transit', 'delivered', 'rto_in_transit', 'ndr', '']) assert.equal(classify({ order_status: s }), 'moving', s);
});

test('the admin message: a NimbusPost copy left live is never hidden behind an XpressBees "cancelled"', () => {
  const xb = { action: 'cancelled', courier: 'XpressBees', awb: '1434', message: 'XpressBees shipment 1434 cancelled.' };
  const npMoving = { handled: true, ok: false, cancelled: [], already: [], failed: [], moving: [{ order_id: 'x' }], message: 'Already picked up in NimbusPost …' };
  assert.equal(withNimbus(xb, npMoving).action, 'moving');
  const npDone = { handled: true, ok: true, cancelled: [{ order_id: 'y' }], already: [], failed: [], moving: [], message: 'NimbusPost order cancelled for good: IC-1.' };
  const notSup = { action: 'not_supported', awb: '404', message: 'Delhivery shipment 404 was NOT cancelled automatically.' };
  assert.deepEqual(withNimbus(notSup, npDone).action, 'cancelled');
  assert.equal(withNimbus(null, npDone).courier, 'NimbusPost');
  assert.equal(withNimbus(xb, { handled: false }), xb);
});

test('dryRun lists what would be cancelled and sends no cancel', async () => {
  const { v2Fetch, calls } = fakeNp([
    { order_id: 'NP1', order_number: 'IC-20261110-S2XH3', order_status: 'cancelled', shipment: { awb: '1' } },
    { order_id: 'NP2', order_number: 'IC-20261110-S2XH3-c', order_status: 'ready_to_ship', shipment: { awb: '2' } },
    { order_id: 'NP3', order_number: 'IC-20261110-S2XH3-c2', order_status: 'in_transit', shipment: { awb: '3' } },
  ]);
  const r = await cancelNimbusOrderForGood({ orderNumber: 'IC-20261110-S2XH3', dryRun: true }, { v2Fetch });
  assert.equal(r.dry_run, true);
  assert.deepEqual(calls.cancels, []);
  assert.deepEqual(r.would_cancel.map((x) => x.order_id), ['NP2']);
  assert.deepEqual(r.moving.map((x) => x.order_id), ['NP3']);
});
