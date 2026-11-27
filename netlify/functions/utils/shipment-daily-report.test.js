const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('./shipment-daily-report');

const since = new Date('2026-11-26T15:30:00Z');
const until = new Date('2026-11-27T15:30:00Z');
const cart = [{ title: 'Atomic Habits', qty: 2 }];

test('courier names group', () => {
  assert.equal(r.courierGroup('Delhivery Surface DT_Stressed'), 'Delhivery');
  assert.equal(r.courierGroup('Surface Xpressbees 0.5 K.G'), 'XpressBees');
  assert.equal(r.courierGroup(''), 'Not booked');
});

test('stages from courier wording', () => {
  assert.equal(r.stage('pending pickup'), 'Waiting for pickup');
  assert.equal(r.stage('In Transit'), 'In transit');
  assert.equal(r.stage('rad'), 'In transit');
  assert.equal(r.stage('rto in transit'), 'Returning to us (RTO)');
  assert.equal(r.stage('out for delivery'), 'Out for delivery');
  assert.equal(r.stage('exception'), 'Delivery problem');
  assert.equal(r.stage('lookup failed: record not found', 'shipped'), 'Not checked');
});

test('counts only stamps inside the window, one row per event', () => {
  const events = [
    { id: 1, razorpay_order_id: 'IC-A', courier_name: 'Xpressbees', tracking_id: 'X1', cart_items: cart, awb_assigned_at: '2026-11-26T10:00:00Z', shipment_moved_at: '2026-11-27T06:00:00Z' },
    { id: 2, razorpay_order_id: 'IC-B', courier_name: 'Ekart', tracking_id: 'E1', cart_items: cart, shipment_moved_at: '2026-11-26T20:00:00Z', delivered_at: '2026-11-27T12:00:00Z' },
    { id: 3, razorpay_order_id: 'IC-C', courier_name: null, tracking_id: null, cart_items: cart, cancelled_at: '2026-11-27T09:00:00Z' },
    { id: 4, razorpay_order_id: 'IC-D', courier_name: 'DTDC', tracking_id: null, courier_cancelled_awb: 'D1', cart_items: cart, cancelled_at: '2026-11-27T09:00:00Z' },
  ];
  const open = [
    { id: 5, courier_name: 'Xpressbees', last_courier_status: 'pending pickup' },
    { id: 6, courier_name: 'Delhivery Surface DT', last_courier_status: 'in transit' },
    { id: 7, courier_name: 'Xpressbees', last_courier_status: 'delivered' },
  ];
  const s = r.summarise({ events, open, since, until });
  assert.equal(s.counts.booked.total, 0);
  assert.equal(s.counts.picked.total, 2);
  assert.deepEqual(s.counts.picked.byCourier, { XpressBees: 1, Ekart: 1 });
  assert.equal(s.counts.picked.books, 4);
  assert.equal(s.counts.delivered.total, 1);
  assert.equal(s.counts.cancelled.total, 2);
  assert.equal(s.counts.cancelled.afterBooking, 1);
  assert.equal(s.rows.length, 5);
  assert.equal(s.rows[0].event, 'Picked up');
  assert.equal(s.snapshot['Waiting for pickup'].total, 1);
  assert.equal(s.snapshot['In transit'].total, 1);
  assert.equal(s.snapshot.Delivered, undefined);
  const html = r.emailHtml({ ...s, since, until });
  assert.match(html, /Picked up/);
  assert.match(r.subject({ ...s, until }), /2 picked up · 1 delivered · 2 cancelled · 0 booked/);
  const out = r.csv(s.rows);
  assert.match(out, /IC-B/);
  assert.equal(out.split('\r\n').length, 6);
});
