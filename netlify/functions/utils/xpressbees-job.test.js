// The XpressBees run that the admin's "Book on XpressBees (API)" starts:
// processOrders (shared by the HTTP call and worker/xb-booking-job.js), its
// saved price checks, and the owner's email at the end.
const test = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://supabase.invalid';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'x';
const xb = require('./xpressbees');
const ship = require('../xpressbees-ship');

const old = Date.now() - 2 * 3600e3;
const order = (n, extra = {}) => ({
  id: 'db' + n, razorpay_order_id: 'order_T' + n, status: 'paid', source: 'site',
  created_at: new Date(old).toISOString(), tracking_id: null, cancellation_requested_at: null,
  customer_name: 'Asha ' + n, customer_phone: '98765432' + String(n).padStart(2, '0'),
  customer_address: 'House 1, MG Road, Pune, Maharashtra 411001',
  cart_items: JSON.stringify([{ title: 'Book ' + n, qty: 1, price: 299 }]),
  amount_paise: 29900, razorpay_payment_id: 'pay_' + n, ...extra,
});

// Just enough of supabase-js: select().in(), update().eq()[.is().select()].
function fakeDb(rows) {
  const updates = [];
  return {
    updates,
    from() {
      return {
        select: () => ({ in: async (_c, ids) => ({ data: rows.filter(r => ids.includes(r.razorpay_order_id)), error: null }) }),
        update(patch) {
          const q = { eq(_c, id) { updates.push({ id, patch }); return q; }, is() { return q; },
            select: async () => ({ data: [], error: null }), then: (ok) => ok({ error: null }) };
          return q;
        },
      };
    },
  };
}
function fakeStore() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), set: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } };
}
const QUOTE = [{ id: '1', name: 'Surface Xpressbees 0.5 K.G', total_charges: 52 }];

function stubXb(t, { book } = {}) {
  const calls = { quote: 0, book: 0, inFlight: 0, maxInFlight: 0 };
  t.mock.method(xb, 'serviceability', async () => {
    calls.quote++; calls.inFlight++; calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
    await new Promise(r => setTimeout(r, 5));
    calls.inFlight--;
    return QUOTE;
  });
  t.mock.method(xb, 'book', book || (async (p) => { calls.book++; return { awb_number: 'AWB' + p.order_number, courier_name: 'XpressBees' }; }));
  t.mock.method(global, 'fetch', async () => { throw new Error('no network in tests'); });
  return calls;
}

test('a second price check reuses the saved one instead of asking XpressBees', async (t) => {
  const calls = stubXb(t);
  const rows = [order(1), order(2), order(3)];
  const store = fakeStore();
  const opts = { dry_run: true, courier_id: '1', supabase: fakeDb(rows), quoteStore: store };
  const ids = rows.map(r => r.razorpay_order_id);

  const first = await ship.processOrders(ids, opts);
  assert.strictEqual(first.booked.length, 3);
  assert.ok(first.booked.every(b => !b.cached && b.courier_charges === 52));
  assert.strictEqual(calls.quote, 3);

  const second = await ship.processOrders(ids, opts);
  assert.strictEqual(calls.quote, 3, 'no new quotes');
  assert.ok(second.booked.every(b => b.cached));
  assert.deepStrictEqual(second.booked.map(b => b.order_id), ids, 'kept in the order asked');
});

test('changing the address makes the saved check stale', async (t) => {
  const calls = stubXb(t);
  const store = fakeStore();
  const r = order(1);
  await ship.processOrders([r.razorpay_order_id], { dry_run: true, supabase: fakeDb([r]), quoteStore: store });
  const moved = { ...r, customer_address: 'Flat 9, Park Street, Kolkata, West Bengal 700016' };
  const again = await ship.processOrders([r.razorpay_order_id], { dry_run: true, supabase: fakeDb([moved]), quoteStore: store });
  assert.strictEqual(calls.quote, 2);
  assert.strictEqual(again.booked[0].pincode, '700016');
  assert.strictEqual(again.booked[0].cached, false);
});

test('booking after a check uses the saved quote, then drops it', async (t) => {
  const calls = stubXb(t);
  const rows = [order(1), order(2)];
  const store = fakeStore();
  const db = fakeDb(rows);
  const ids = rows.map(r => r.razorpay_order_id);
  await ship.processOrders(ids, { dry_run: true, courier_id: '1', supabase: db, quoteStore: store });
  const out = await ship.processOrders(ids, { courier_id: '1', supabase: db, quoteStore: store });
  assert.strictEqual(calls.quote, 2, 'booking asked for no new prices');
  assert.strictEqual(calls.book, 2);
  assert.deepStrictEqual(out.booked.map(b => b.awb), ['AWBorder_T1', 'AWBorder_T2']);
  assert.strictEqual(store.m.size, 0);
  assert.ok(db.updates.some(u => u.patch.tracking_id === 'AWBorder_T1'));
});

test('orders are checked several at a time', async (t) => {
  const calls = stubXb(t);
  const rows = Array.from({ length: 12 }, (_, i) => order(i + 1));
  await ship.processOrders(rows.map(r => r.razorpay_order_id), { dry_run: true, supabase: fakeDb(rows), quoteStore: null });
  assert.strictEqual(calls.quote, 12);
  assert.ok(calls.maxInFlight > 1 && calls.maxInFlight <= 6, 'max in flight ' + calls.maxInFlight);
});

test('an unserviceable pincode is remembered; a wallet refusal is not and stops the rest', async (t) => {
  const store = fakeStore();
  stubXb(t);
  xb.serviceability.mock.mockImplementation(async ({ destination }) => (destination === '411001' ? [] : QUOTE));
  const bad = order(1);
  await ship.processOrders([bad.razorpay_order_id], { dry_run: true, supabase: fakeDb([bad]), quoteStore: store });
  assert.strictEqual(store.m.size, 1);
  const again = await ship.processOrders([bad.razorpay_order_id], { dry_run: true, supabase: fakeDb([bad]), quoteStore: store });
  assert.strictEqual(again.failed[0].cached, true);

  xb.book.mock.mockImplementation(async () => { throw new Error('Insufficient wallet balance'); });
  const rows = Array.from({ length: 6 }, (_, i) => order(i + 10, { customer_address: 'House 1, MG Road, Mumbai, Maharashtra 400001' }));
  const out = await ship.processOrders(rows.map(r => r.razorpay_order_id), { concurrency: 1, supabase: fakeDb(rows), quoteStore: fakeStore() });
  assert.strictEqual(out.booked.length, 0);
  assert.strictEqual(out.failed.length, 1);
  assert.strictEqual(out.failed[0].kind, 'wallet');
  assert.ok(out.skipped.every(s => s.kind === 'wallet_stop') && out.skipped.length === 5);
});

test('the owner is emailed the result of a booking run, not of a price check', async () => {
  process.env.STORE_OWNER_EMAIL = 'owner@example.test';
  const sent = [];
  const sendEmail = async (m) => { sent.push(m); };
  const job = {
    mode: 'book', started_at: Date.now(), stop_reason: 'wallet',
    booked: [{ order_id: 'order_A', awb: 'AWB1', collectable: 0, courier_charges: 52, db_updated: true, notified: { whatsapp: true, email: true } }],
    failed: [{ order_id: 'order_B', kind: 'wallet', title: 'Wallet empty', error: 'Insufficient wallet balance' }],
    skipped: [], not_attempted: ['order_C'],
  };
  assert.deepStrictEqual(await ship.jobFinished(job, { sendEmail }), { sent: true });
  assert.strictEqual(sent[0].to, 'owner@example.test');
  assert.match(sent[0].subject, /1 booked, 1 failed — stopped/);
  assert.match(sent[0].html, /AWB1/);
  assert.match(sent[0].html, /order_C/);
  assert.match(sent[0].html, /wallet ran out/);
  assert.deepStrictEqual(await ship.jobFinished({ ...job, mode: 'preview' }, { sendEmail }), { skipped: 'preview' });
  assert.strictEqual(sent.length, 1);
});
