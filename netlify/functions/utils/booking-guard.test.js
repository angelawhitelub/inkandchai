const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const g = require('./booking-guard');

const panel = (rows) => ({ panelOrders: async ({ params }) => {
  if (params.page_no !== '1') throw new Error('No data Found');
  return { rows };
} });

const order = (extra = {}) => ({ id: 'row', razorpay_order_id: 'IC-20261104-Y3KMW', status: 'confirmed', ...extra });

test('IC-20261104-Y3KMW: booked in the XpressBees panel, AWB never came back -> no courier may book it', async () => {
  const deps = panel([
    { id: 1, order_number: 'IC-20261104-Y3KMW', status: 'booked', awb_numbers: '' },
    { id: 2, order_number: 'IC-20261104-Y3KMW-c1', status: 'cancelled', awb_number: '143449611687900' },
  ]);
  for (const courier of ['ekart', 'nimbuspost', 'delhivery', 'ithink', 'shiprocket', 'xpressbees']) {
    const guard = await g.bookingGuard({ courier, deps });
    const block = guard(order());
    assert.equal(block && block.kind, 'xb_panel_booked', courier);
    assert.match(block.reason, /XpressBees panel already has IC-20261104-Y3KMW booked/);
  }
});

test('a panel row with an AWB but status "new" still counts as booked', async () => {
  const guard = await g.bookingGuard({ courier: 'ekart', deps: panel([{ id: 1, order_number: 'IC-1-P', status: 'new', awb_number: '1434' }]) });
  assert.equal(guard(order({ razorpay_order_id: 'IC-1' })).kind, 'xb_panel_booked');
});

test('only queued or cancelled panel rows let another courier book', async () => {
  const deps = panel([
    { id: 1, order_number: 'IC-Q', status: 'new', awb_numbers: '' },
    { id: 2, order_number: 'IC-NP', status: 'cancelled', awb_number: '143' },
  ]);
  const guard = await g.bookingGuard({ courier: 'ekart', deps });
  assert.equal(guard(order({ razorpay_order_id: 'IC-Q' })), null);
  assert.equal(guard(order({ razorpay_order_id: 'IC-NP' })), null);
  assert.equal(guard(order({ razorpay_order_id: 'IC-NEVER' })), null);
});

test('an AWB on the order blocks every courier, whatever the panel says', async () => {
  const guard = await g.bookingGuard({ courier: 'xpressbees', deps: panel([]) });
  const block = guard(order({ tracking_id: 'EK123', courier_name: 'Ekart' }));
  assert.equal(block.kind, 'has_awb');
  assert.match(block.reason, /EK123 \(Ekart\)/);
});

test('cannot read the panel -> nothing books (fails closed)', async () => {
  const guard = await g.bookingGuard({ courier: 'ekart', deps: { panelOrders: async () => { throw new Error('XpressBees login failed'); } } });
  assert.equal(guard(order()).kind, 'guard_unavailable');
  assert.ok(guard.unavailable);
});

test('a NimbusPost or iThink push blocks the others, lifted only for an order named in released_elsewhere', async () => {
  const deps = panel([]);
  const np = order({ nimbus_pushed_at: '2026-11-05T00:00:00Z' });
  assert.equal((await g.bookingGuard({ courier: 'ekart', deps }))(np).kind, 'pushed_elsewhere');
  assert.equal((await g.bookingGuard({ courier: 'nimbuspost', deps }))(np), null, 'NimbusPost itself is not blocked by its own stamp');
  assert.equal((await g.bookingGuard({ courier: 'ekart', deps, released: ['ic-20261104-y3kmw'] }))(np), null);
  const it = order({ ithink_pushed_at: '2026-11-05T00:00:00Z' });
  assert.equal((await g.bookingGuard({ courier: 'xpressbees', deps }))(it).kind, 'pushed_elsewhere');
  // A release never lifts an AWB or an XpressBees panel booking.
  const booked = panel([{ id: 1, order_number: 'IC-20261104-Y3KMW', status: 'booked' }]);
  assert.equal((await g.bookingGuard({ courier: 'ekart', deps: booked, released: ['IC-20261104-Y3KMW'] }))(np).kind, 'xb_panel_booked');
});

test('released_elsewhere only counts for orders the request names, never an "all" run', () => {
  assert.deepEqual(g.releasedFrom({ released_elsewhere: ['IC-1', 'IC-2'] }, ['IC-1']), ['IC-1']);
  assert.deepEqual(g.releasedFrom({ released_elsewhere: ['IC-1'], all_unshipped: true }, []), []);
  assert.deepEqual(g.releasedFrom({}, ['IC-1']), []);
});

test('an XpressBees re-book may replace only the order\'s own AWB', async () => {
  const own = panel([{ id: 1, order_number: 'IC-R', status: 'booked', awb_number: 'XB1' }]);
  const guard = await g.bookingGuard({ courier: 'xpressbees', deps: own });
  const o = order({ razorpay_order_id: 'IC-R', tracking_id: 'XB1' });
  assert.equal(guard(o).kind, 'has_awb', 'plain force does not get past an AWB');
  assert.equal(guard(o, { rebookingAwb: 'XB1' }), null);
  // The panel has a DIFFERENT live booking: still refused.
  const other = panel([{ id: 1, order_number: 'IC-R', status: 'booked', awb_number: 'XB2' }]);
  assert.equal((await g.bookingGuard({ courier: 'xpressbees', deps: other }))(o, { rebookingAwb: 'XB1' }).kind, 'xb_panel_booked');
});

test('panel order-number suffixes map back to our order', () => {
  assert.equal(g.baseOrderNumber('ic-20261104-y3kmw-c2'), 'IC-20261104-Y3KMW');
  assert.equal(g.baseOrderNumber('IC-1-P'), 'IC-1');
  assert.equal(g.baseOrderNumber('IC-1-R1'), 'IC-1');
});

test('every booking path calls the guard, and force does not skip it', () => {
  const dir = path.resolve(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  for (const f of ['ekart-bulk-push.js', 'delhivery-bulk-push.js', 'ithink-order-push.js', 'shiprocket-bulk-push.js',
    'nimbuspost-order-push.js', 'xpressbees-ship.js', 'utils/nimbus-push-once.js']) {
    assert.match(read(f), /bookingGuard\(\{ courier: '/, f);
  }
  assert.match(read('nimbuspost-ship.js'), /await assertBookable\(order, 'nimbuspost'/);
  const xbs = read('xpressbees-ship.js');
  assert.doesNotMatch(xbs, /order\.tracking_id && !force/);
  assert.match(xbs, /guard\(order, \{ rebookingAwb: opts\.cancel_existing \? order\.tracking_id : null \}\)/);
});

test('double-bookings report: two live XpressBees parcels, or XpressBees plus another courier', () => {
  const { analyse } = require('../admin-double-bookings')._test;
  const panelRows = [
    { id: 1, order_number: 'IC-A', status: 'booked', awb_number: 'XB1' },
    { id: 2, order_number: 'IC-A-c1', status: 'in transit', awb_number: 'XB2' },
    { id: 3, order_number: 'IC-B', status: 'booked', awb_numbers: '' },
    { id: 4, order_number: 'IC-NP', status: 'booked', awb_numbers: '' },
    { id: 5, order_number: 'IC-D', status: 'booked', awb_number: 'XB4' },
    { id: 6, order_number: 'IC-E', status: 'cancelled', awb_number: 'XB5' },
    { id: 7, order_number: 'IC-F', status: 'booked', awb_numbers: '' },
  ];
  const orders = new Map([
    ['IC-A', { razorpay_order_id: 'IC-A', tracking_id: 'XB1', courier_name: 'XpressBees' }],
    ['IC-B', { razorpay_order_id: 'IC-B', tracking_id: 'EK9', courier_name: 'Ekart' }],
    ['IC-NP', { razorpay_order_id: 'IC-NP', tracking_id: null, nimbus_pushed_at: '2026-11-05' }],
    ['IC-D', { razorpay_order_id: 'IC-D', tracking_id: 'XB4', courier_name: 'XpressBees' }],
    ['IC-E', { razorpay_order_id: 'IC-E', tracking_id: 'EK1', courier_name: 'Ekart' }],
    ['IC-F', { razorpay_order_id: 'IC-F', tracking_id: null }],
  ]);
  const r = analyse(panelRows, orders);
  assert.deepEqual(r.doubles.map((d) => d.order_id).sort(), ['IC-A', 'IC-B', 'IC-NP']);
  assert.match(r.doubles.find((d) => d.order_id === 'IC-B').why.join(), /also booked with Ekart EK9/);
  assert.deepEqual(r.awb_missing.map((d) => d.order_id), ['IC-F']);
});

test('the report is read-only', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../admin-double-bookings.js'), 'utf8');
  assert.doesNotMatch(src, /\.update\(|\.insert\(|\.delete\(|cancel\(|sendText|sendEmail/);
});

test('Shiprocket is retired: its stamp no longer blocks other couriers unless SHIPROCKET_ACTIVE=1', async () => {
  const prev = process.env.SHIPROCKET_ACTIVE;
  try {
    delete process.env.SHIPROCKET_ACTIVE;
    const guard = await g.bookingGuard({ courier: 'nimbuspost', deps: panel([]) });
    assert.equal(guard(order({ shiprocket_order_id: '1720035677' })), null);
    process.env.SHIPROCKET_ACTIVE = '1';
    const guard2 = await g.bookingGuard({ courier: 'nimbuspost', deps: panel([]) });
    assert.equal(guard2(order({ shiprocket_order_id: '1720035677' })).kind, 'pushed_elsewhere');
  } finally {
    if (prev === undefined) delete process.env.SHIPROCKET_ACTIVE; else process.env.SHIPROCKET_ACTIVE = prev;
  }
});

test('Shiprocket checkout push is off unless SHIPMENT_AUTO_PUSH=shiprocket', async () => {
  const prev = process.env.SHIPMENT_AUTO_PUSH;
  delete process.env.SHIPMENT_AUTO_PUSH;
  try {
    const out = await require('./shiprocket').autoPushOrderToShiprocket({ inkOrderId: 'IC-1', cartItems: [] });
    assert.equal(out.skipped, true);
    assert.equal(out.mode, 'off');
  } finally { if (prev !== undefined) process.env.SHIPMENT_AUTO_PUSH = prev; }
});
