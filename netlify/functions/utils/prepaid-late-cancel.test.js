const test = require('node:test');
const assert = require('node:assert/strict');
const {
  quoteLateCancel, executeLateCancel, sweepAwaitingReturn, shippingDeduction, halfKgSlabs,
} = require('./prepaid-late-cancel');

const HOUR = 3600000;
const NOW = new Date('2026-09-28T12:00:00Z').getTime();
const AWB = '143449610819605';

// One orders row; an update lands only when every condition matches, like Postgres.
function fakeDb(row, { missingColumn = false } = {}) {
  const db = { row: { ...row }, updates: [] };
  db.from = () => {
    const q = { conds: [] };
    const match = () => q.conds.every(([op, col, val]) => {
      if (op === 'eq') return String(db.row[col]) === String(val);
      if (op === 'in') return val.includes(db.row[col]);
      if (op === 'is') return db.row[col] == val;
      return true;
    });
    const run = (single) => {
      if (!q.update) {
        const hit = match() ? db.row : null;
        return { data: single ? hit : (hit ? [hit] : []), error: null };
      }
      if (missingColumn && 'late_cancel_at' in q.update) {
        return { data: null, error: { message: 'column orders.late_cancel_at does not exist' } };
      }
      if (!match()) return { data: single ? null : [], error: null };
      Object.assign(db.row, q.update);
      db.updates.push(q.update);
      return { data: single ? { id: db.row.id } : [{ id: db.row.id }], error: null };
    };
    const b = {
      select() { return b; },
      limit() { return b; },
      update(u) { q.update = u; return b; },
      eq(c, v) { q.conds.push(['eq', c, v]); return b; },
      in(c, v) { q.conds.push(['in', c, v]); return b; },
      is(c, v) { q.conds.push(['is', c, v]); return b; },
      maybeSingle() { return Promise.resolve(run(true)); },
      then(ok, bad) { return Promise.resolve(run(false)).then(ok, bad); },
    };
    return b;
  };
  return db;
}

const order = (over = {}) => ({
  id: 'u1',
  razorpay_order_id: 'IC-20260926-ABCDE',
  razorpay_payment_id: 'OMO2609261234',
  amount_paise: 39900,
  status: 'shipped',
  shipment_payment_type: 'prepaid',
  courier_name: 'Xpressbees',
  tracking_id: AWB,
  created_at: new Date(NOW - 30 * HOUR).toISOString(),
  customer_name: 'Riya Sharma',
  customer_email: 'riya@example.com',
  customer_phone: '9876543210',
  cart_items: [{ title: 'Atomic Habits', qty: 1, price: 399 }],
  ...over,
});

function deps({ xb = 'cancelled', np = { ok: false, error: 'cannot cancel' }, dl = { ok: false, error: 'not ours' },
                phonepe = { ok: true, state: 'COMPLETED', merchantRefundId: 'REF-1', refundId: 'PP1' } } = {}) {
  const d = { emails: [], wa: [], refunds: [], notified: [], xbCalls: 0, npCalls: 0, dlCalls: 0, npOrder: 0 };
  d.sendEmail = async (m) => { d.emails.push(m); return { ok: true }; };
  d.sendWhatsApp = async (m) => { d.wa.push(m); return { ok: true }; };
  d.cancelCourierShipment = async (o) => {
    d.xbCalls += 1;
    if (xb === 'cancelled') return { action: 'cancelled', awb: o.tracking_id, message: 'cancelled' };
    if (xb === 'not_found') return { action: 'error', message: 'Could not read the XpressBees status: Record not found' };
    return { action: 'moving', state: xb, message: `XpressBees shipment is "${xb}", too late to cancel.` };
  };
  d.recordCourierCancel = async () => {};
  d.cancelNimbusShipment = async () => { d.npCalls += 1; return np; };
  d.cancelNimbusOrder = async () => { d.npOrder += 1; return { ok: true }; };
  d.cancelDelhivery = async () => { d.dlCalls += 1; return dl; };
  d.razorpayRefund = async (pid, amount) => { d.refunds.push({ gateway: 'razorpay', amount }); return { id: 'rfnd_1', status: 'processed' }; };
  d.phonePeRefund = async ({ amountPaise }) => { d.refunds.push({ gateway: 'phonepe', amount: amountPaise }); return phonepe; };
  d.sendRefundInitiated = async (o, amount, opts) => { d.notified.push({ amount, opts }); return { sent: true }; };
  return d;
}

process.env.STORE_OWNER_EMAIL = 'owner@example.com';

test('shipping is Rs 74 per 0.5 kg slab: 1 book 0.5 kg, 2 books 1 kg, then whole kilos up to 5 kg', () => {
  const want = { 1: 1, 2: 2, 3: 4, 4: 4, 5: 6, 6: 6, 7: 8, 8: 8, 9: 10, 20: 10 };
  for (const [books, slabs] of Object.entries(want)) assert.equal(halfKgSlabs(Number(books)), slabs, `${books} books`);
  assert.equal(shippingDeduction(order()).paise, 7400);
  assert.equal(shippingDeduction(order({ cart_items: [{ title: 'A', qty: 2 }] })).paise, 14800);
  // A bundle is one cart line but several books.
  const set = shippingDeduction(order({ cart_items: [{ title: 'Classics Set of 3 Books', qty: 1 }] }));
  assert.deepEqual([set.books, set.slabKg, set.paise], [3, 2, 29600]);
});

test('who can cancel here, and on what terms', () => {
  assert.deepEqual(
    (({ eligible, deductionPaise, refundPaise }) => ({ eligible, deductionPaise, refundPaise }))(quoteLateCancel(order(), NOW)),
    { eligible: true, deductionPaise: 7400, refundPaise: 32500 });

  const unbooked = quoteLateCancel(order({ status: 'paid', tracking_id: null, courier_name: null }), NOW);
  assert.equal(unbooked.eligible, true);
  assert.equal(unbooked.deductionPaise, 0);
  assert.equal(unbooked.refundPaise, 39900);

  const refusals = [
    [{ status: 'paid', tracking_id: null, created_at: new Date(NOW - 10 * 60000).toISOString() }, 'instant_window'],
    [{ status: 'out_for_delivery' }, 'closed'],
    [{ last_courier_status: 'Out For Delivery' }, 'closed'],
    [{ last_nimbuspost_status: 'Delivered' }, 'closed'],
    [{ last_courier_status: 'RTO In Transit' }, 'closed'],
    [{ status: 'delivered' }, 'closed'],
    [{ shipment_payment_type: 'cod' }, 'not_prepaid'],
    [{ razorpay_payment_id: null }, 'not_prepaid'],
    [{ advance_paid_paise: 4000 }, 'not_prepaid'],
    [{ source: 'replacement', razorpay_order_id: 'IC-R-20260926-ZZZZZ' }, 'not_prepaid'],
    [{ late_cancel_at: new Date(NOW).toISOString() }, 'already_requested'],
    [{ amount_paise: 7000 }, 'nothing_to_refund'],
  ];
  for (const [over, reason] of refusals) {
    assert.equal(quoteLateCancel(order(over), NOW).reason, reason, JSON.stringify(over));
  }
});

test('no AWB past 30 minutes: cancelled at once, panel row cleared, full refund', async () => {
  const db = fakeDb(order({ status: 'paid', tracking_id: null, courier_name: null }));
  const d = deps();
  const r = await executeLateCancel(db, db.row, { now: NOW }, d);
  assert.equal(r.ok, true, r.message);
  assert.equal(d.npOrder, 1);
  assert.deepEqual(d.refunds, [{ gateway: 'phonepe', amount: 39900 }]);
  assert.equal(db.row.status, 'refunded');
  assert.equal(db.row.late_cancel_state, 'refunded');
  assert.equal(d.notified.length, 1);
  assert.ok(d.emails.some((e) => e.to === 'riya@example.com'));
  assert.equal(d.wa.length, 1);
});

test('XpressBees not picked up: AWB cancelled, refund minus shipping straight away', async () => {
  const db = fakeDb(order({ razorpay_payment_id: 'pay_ABC' }));
  const d = deps({ xb: 'cancelled' });
  const r = await executeLateCancel(db, db.row, { now: NOW }, d);
  assert.equal(r.outcome, 'refund');
  assert.deepEqual(d.refunds, [{ gateway: 'razorpay', amount: 32500 }]);
  assert.equal(db.row.status, 'partially_refunded');
  assert.equal(db.row.cancellation_fee_paise, 7400);
  assert.equal(db.row.refund_amount_paise, 32500);
  assert.equal(d.npCalls, 0);
});

test('XpressBees already picked up: no refund yet, owner told to raise the RTO', async () => {
  const db = fakeDb(order());
  const d = deps({ xb: 'In Transit' });
  const r = await executeLateCancel(db, db.row, { now: NOW }, d);
  assert.equal(r.outcome, 'awaiting_return');
  assert.equal(d.refunds.length, 0);
  assert.equal(db.row.status, 'shipped');
  assert.equal(db.row.late_cancel_state, 'awaiting_return');
  assert.ok(d.emails.some((e) => /RTO needed/.test(e.subject)));
  const customer = d.emails.find((e) => e.to === 'riya@example.com');
  assert.match(customer.html, /refuse the delivery/);
  assert.match(customer.html, /₹325/);
});

test('out for delivery by the time they click: refused, and the claim is undone', async () => {
  const db = fakeDb(order());
  const d = deps({ xb: 'Out For Delivery' });
  const r = await executeLateCancel(db, db.row, { now: NOW }, d);
  assert.equal(r.ok, false);
  assert.match(r.message, /Cancellation expired/);
  assert.equal(db.row.late_cancel_at, null);
  assert.equal(db.row.refund_amount_paise, null);
  assert.equal(d.refunds.length, 0);
  assert.equal(d.emails.length, 0);
});

test('Delhivery: NimbusPost refuses, Delhivery accepts the cancel, refund goes', async () => {
  const db = fakeDb(order({ courier_name: 'Delhivery', tracking_id: '21025863355912' }));
  const d = deps({ dl: { ok: true } });
  const r = await executeLateCancel(db, db.row, { now: NOW }, d);
  assert.equal(r.outcome, 'refund');
  assert.equal(d.xbCalls, 0);
  assert.equal(d.npCalls, 1);
  assert.equal(d.dlCalls, 1);
  assert.deepEqual(d.refunds, [{ gateway: 'phonepe', amount: 32500 }]);
});

test('an XpressBees AWB booked through NimbusPost is cancelled through NimbusPost', async () => {
  const db = fakeDb(order());
  const d = deps({ xb: 'not_found', np: { ok: true } });
  const r = await executeLateCancel(db, db.row, { now: NOW }, d);
  assert.equal(r.outcome, 'refund');
  assert.equal(d.npCalls, 1);
});

test('a second click never pays twice', async () => {
  const db = fakeDb(order());
  const d = deps({ xb: 'cancelled' });
  await executeLateCancel(db, db.row, { now: NOW }, d);
  const again = await executeLateCancel(db, { ...order() }, { now: NOW }, d);   // stale copy of the row
  assert.equal(again.ok, false);
  assert.equal(d.refunds.length, 1);
});

test('PhonePe PENDING is not announced as refunded', async () => {
  const db = fakeDb(order());
  const d = deps({ xb: 'cancelled', phonepe: { ok: true, state: 'PENDING', merchantRefundId: 'REF-1' } });
  await executeLateCancel(db, db.row, { now: NOW }, d);
  assert.equal(db.row.status, 'refund_pending');
  assert.equal(db.row.late_cancel_state, 'refund_pending');
  assert.equal(d.notified.length, 0);
});

test('without the migration nothing is cancelled or refunded', async () => {
  const db = fakeDb(order(), { missingColumn: true });
  const d = deps();
  const r = await executeLateCancel(db, db.row, { now: NOW }, d);
  assert.equal(r.status, 503);
  assert.equal(d.refunds.length, 0);
  assert.equal(d.xbCalls, 0);
});

test('sweep: refunds once when the parcel is coming back, never when delivered', async () => {
  const waiting = { late_cancel_at: new Date(NOW).toISOString(), late_cancel_state: 'awaiting_return',
                    cancellation_fee_paise: 7400, refund_amount_paise: 32500 };

  const rto = fakeDb(order({ ...waiting, status: 'rto' }));
  const d = deps();
  const first = await sweepAwaitingReturn(rto, {}, d);
  assert.equal(first.refunded.length, 1);
  assert.deepEqual(d.refunds, [{ gateway: 'phonepe', amount: 32500 }]);
  assert.equal(rto.row.status, 'partially_refunded');
  await sweepAwaitingReturn(rto, {}, d);
  assert.equal(d.refunds.length, 1);

  const xbCancelled = fakeDb(order({ ...waiting, last_courier_status: 'cancelled' }));
  const d2 = deps();
  assert.equal((await sweepAwaitingReturn(xbCancelled, {}, d2)).refunded.length, 1);

  const moving = fakeDb(order({ ...waiting, last_courier_status: 'In Transit' }));
  const d3 = deps();
  const w = await sweepAwaitingReturn(moving, {}, d3);
  assert.equal(w.waiting, 1);
  assert.equal(d3.refunds.length, 0);

  const delivered = fakeDb(order({ ...waiting, status: 'delivered' }));
  const d4 = deps();
  const del = await sweepAwaitingReturn(delivered, {}, d4);
  assert.equal(del.delivered.length, 1);
  assert.equal(d4.refunds.length, 0);
  assert.equal(delivered.row.late_cancel_state, 'delivered_anyway');
  assert.ok(d4.emails.some((e) => /delivered after the customer cancelled/.test(e.subject)));
});
