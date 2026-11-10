const test = require('node:test');
const assert = require('node:assert/strict');
const { run, stage, message, worthSending } = require('../cancelled-parcels-scheduled')._test;

test('courier statuses sort into waiting / moving / done', () => {
  for (const s of ['pending pickup', 'booked', 'ready_to_ship', 'pickup_pending', 'Manifested']) assert.equal(stage(s), 'waiting', s);
  for (const s of ['in transit', 'in_transit', 'out for delivery', 'exception', 'undelivered', '']) assert.equal(stage(s), 'moving', s);
  for (const s of ['delivered', 'rto', 'rto in transit', 'rto delivered', 'lost_damaged']) assert.equal(stage(s), 'done', s);
});

const row = (order_id, xb_status, extra = {}) => ({
  kind: 'order_closed', source: 'XpressBees', courier: 'XpressBees', awb: `AWB-${order_id}`, xb_status,
  order_id, our_status: 'cancelled', _order: { id: order_id, razorpay_order_id: order_id, status: 'cancelled' }, ...extra,
});

const fakeReport = (rows) => async () => ({ live: rows.length + 5, errors: {}, rows: [...rows, { kind: 'ok', order_id: 'IC-OK' }] });

test('stops only waiting parcels of closed orders, lists the rest', async () => {
  const calls = [];
  const deps = {
    call: () => {},
    report: fakeReport([row('IC-W', 'pending pickup'), row('IC-T', 'in transit'), row('IC-D', 'delivered'),
      row('IC-NP', 'ready_to_ship', { source: 'NimbusPost', courier: 'Delhivery' }), row('IC-L', 'booked')]),
    stopShipment: async (db, order, sdeps, opts) => {
      calls.push([order.razorpay_order_id, opts.awb, opts.courierHint]);
      if (order.razorpay_order_id === 'IC-L') return { code: 200, body: { courier: { action: 'moving', state: 'in transit' } } };
      return { code: 200, body: { ok: true, courier: { action: 'cancelled' } } };
    },
  };
  const out = await run({}, { dryRun: false, stop: true }, deps);
  assert.deepEqual(calls, [['IC-W', 'AWB-IC-W', 'xpressbees'], ['IC-NP', 'AWB-IC-NP', 'nimbuspost'], ['IC-L', 'AWB-IC-L', 'xpressbees']]);
  assert.deepEqual(out.stopped.map((x) => x.order_id), ['IC-W', 'IC-NP']);
  assert.deepEqual(out.moving.map((x) => x.order_id), ['IC-T', 'IC-L'], 'picked up between the list and the live check');
  assert.deepEqual(out.done.map((x) => x.order_id), ['IC-D']);
  assert.match(message(out), /Stopped before pickup \(2\)[\s\S]*Already picked up \(2\)/);
});

test('dry run and the off switch stop nothing', async () => {
  const deps = { call: () => {}, report: fakeReport([row('IC-W', 'pending pickup')]), stopShipment: async () => { throw new Error('must not stop'); } };
  const dry = await run({}, { dryRun: true, stop: true }, deps);
  assert.equal(dry.not_stopped[0].why, 'dry run');
  const off = await run({}, { dryRun: false, stop: false }, deps);
  assert.equal(off.not_stopped[0].why, 'stopping is switched off');
});

test('a refused stop (refunded order, AWB on another order) is listed, not hidden', async () => {
  const deps = { call: () => {}, report: fakeReport([row('IC-R', 'pending pickup', { our_status: 'refunded' })]),
    stopShipment: async () => ({ code: 400, body: { error: 'Order is "refunded", not cancelled.' } }) };
  const out = await run({}, { dryRun: false, stop: true }, deps);
  assert.match(out.not_stopped[0].why, /refunded/);
  assert.ok(worthSending(out));
});

test('finished parcels alone send nothing', async () => {
  const out = await run({}, { dryRun: false, stop: true }, { call: () => {}, report: fakeReport([row('IC-D', 'delivered')]) });
  assert.equal(worthSending(out), false);
});

test('only the cron header skips admin auth, and HTTP defaults to a dry run', () => {
  const src = require('fs').readFileSync(require('path').resolve(__dirname, '../cancelled-parcels-scheduled.js'), 'utf8');
  assert.match(src, /const fromCron = !!\(event\.headers && event\.headers\['x-cloudflare-cron'\]\)/);
  assert.match(src, /fromCron \? false : body\.dry_run !== false/);
});
