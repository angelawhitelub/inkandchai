'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const reship = require('./rto-reship');

function order(over = {}) {
  return {
    id: 'uuid-1',
    razorpay_order_id: 'IC-20261020-AAAAA',
    razorpay_payment_id: 'OMO123',
    amount_paise: 49900,
    status: 'rto',
    created_at: new Date(Date.now() - 8 * 86400000).toISOString(),
    customer_name: 'Riya Sharma',
    customer_phone: '+91 98765 43210',
    customer_email: 'r@example.com',
    customer_address: '12 Lake Road, Kolkata, West Bengal - 700029',
    cart_items: [{ title: 'Some Book', qty: 1, price: 499 }],
    source: 'website',
    refund_id: null,
    refund_state: null,
    rto_offer_sent_at: null,
    rto_offer_state: null,
    ...over,
  };
}

/** supabase-js, as much as rto-reship uses. */
function fakeSupabase(rows) {
  const db = { orders: rows.map(r => ({ ...r })) };
  const inserted = [];
  function from(table) {
    const q = { op: 'select', filters: [], payload: null, single: false };
    const match = (r) => q.filters.every(([c, k, v]) =>
      k === 'eq' ? r[c] === v : k === 'is' ? (r[c] ?? null) === v : k === 'in' ? v.includes(r[c])
        : k === 'gte' ? String(r[c]) >= v : true);
    const run = () => {
      if (q.op === 'insert') {
        const row = { id: `uuid-${db[table].length + 1}`, ...q.payload };
        db[table].push(row); inserted.push(row);
        return { data: q.single ? row : [row], error: null };
      }
      const hit = db[table].filter(match);
      if (q.op === 'update') hit.forEach(r => Object.assign(r, q.payload));
      return { data: hit.map(r => ({ ...r })), error: null };
    };
    const api = {
      select() { return api; },
      eq(c, v) { q.filters.push([c, 'eq', v]); return api; },
      is(c, v) { q.filters.push([c, 'is', v]); return api; },
      in(c, v) { q.filters.push([c, 'in', v]); return api; },
      gte(c, v) { q.filters.push([c, 'gte', v]); return api; },
      order() { return api; },
      limit() { return api; },
      single() { q.single = true; return api; },
      update(p) { q.op = 'update'; q.payload = p; return api; },
      insert(p) { q.op = 'insert'; q.payload = p; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }
  return { from, db, inserted };
}

const sendSpy = (ok = true) => {
  const calls = [];
  const fn = async (m) => { calls.push(m); return { ok }; };
  fn.calls = calls;
  return fn;
};

test('offer goes only to prepaid RTO orders, once', async () => {
  const supabase = fakeSupabase([
    order(),
    order({ id: 'cod', razorpay_order_id: 'IC-COD', razorpay_payment_id: null }),
    order({ id: 'pcod', razorpay_order_id: 'IC-PCOD', cart_items: [{ title: 'X', _payment: { mode: 'partial_cod' } }] }),
    order({ id: 'repl', razorpay_order_id: 'IC-R-20261020-BBBBB', source: 'replacement' }),
    order({ id: 'refunding', razorpay_order_id: 'IC-REF', refund_state: 'AUTO_CLAIMED' }),
  ]);
  const send = sendSpy();
  const s = await reship.sendOffers({ supabase, send }, { template: 'rto_reship_offer' });
  assert.deepEqual(s.sent.map(x => x.order_id), ['IC-20261020-AAAAA']);
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].template, 'rto_reship_offer');
  // {{1}} first name, {{2}} order, {{3}} books, {{4}} refund (₹499 − ₹74)
  assert.deepEqual(send.calls[0].params, ['Riya', 'IC-20261020-AAAAA', 'Some Book', '425']);
  const row = supabase.db.orders.find(r => r.id === 'uuid-1');
  assert.equal(row.rto_offer_state, 'sent');
  assert.ok(row.rto_offer_sent_at);

  const again = await reship.sendOffers({ supabase, send }, { template: 'rto_reship_offer' });
  assert.equal(again.sent.length, 0);
  assert.equal(send.calls.length, 1);
});

test('no template, no messages', async () => {
  const supabase = fakeSupabase([order()]);
  const send = sendSpy();
  const s = await reship.sendOffers({ supabase, send }, { template: '' });
  assert.equal(s.enabled, false);
  assert.equal(send.calls.length, 0);
  assert.equal(supabase.db.orders[0].rto_offer_sent_at, null);
});

test('a failed send releases the claim, so the refund is not held for an unseen offer', async () => {
  const supabase = fakeSupabase([order()]);
  const s = await reship.sendOffers({ supabase, send: sendSpy(false) }, { template: 't' });
  assert.equal(s.failed.length, 1);
  assert.equal(supabase.db.orders[0].rto_offer_sent_at, null);
  assert.equal(supabase.db.orders[0].rto_offer_state, null);
});

test('opted-out customers are not messaged', async () => {
  const supabase = fakeSupabase([order()]);
  const send = sendSpy();
  const s = await reship.sendOffers({ supabase, send, isOptedOut: async () => true }, { template: 't' });
  assert.equal(send.calls.length, 0);
  assert.match(s.skipped[0].reason, /opted out/);
});

test('reading replies', () => {
  assert.equal(reship.decisionOf('Yes, send it again'), 'yes');
  assert.equal(reship.decisionOf('No, refund me'), 'no');
  assert.equal(reship.decisionOf('haan bhej do'), 'yes');
  assert.equal(reship.decisionOf('please refund'), 'no');
  assert.equal(reship.decisionOf('nahi chahiye'), 'no');
  assert.equal(reship.decisionOf('when will it come back?'), null);
  const a = reship.addressFrom('No. 4, 2nd Cross, Indiranagar, Bengaluru, Karnataka 560038, phone 9123456789');
  assert.equal(a.pincode, '560038');
  assert.equal(a.phone, '9123456789');
  assert.doesNotMatch(a.address, /9123456789/);
  assert.equal(reship.addressFrom('yes'), null);
});

const sent = (over = {}) => order({ rto_offer_sent_at: new Date().toISOString(), rto_offer_state: 'sent', ...over });

test('YES → confirm address → YES creates one free replacement, and the offer closes', async () => {
  const supabase = fakeSupabase([sent()]);
  const alerts = [];
  const deps = { supabase, ownerAlert: async (t) => alerts.push(t) };

  const r1 = await reship.handleOfferReply(deps, '919876543210', 'Yes, send it again');
  assert.equal(r1.handled, true);
  assert.match(r1.reply, /12 Lake Road/);
  assert.equal(supabase.db.orders[0].rto_offer_state, 'confirm_address');

  const r2 = await reship.handleOfferReply(deps, '919876543210', 'yes');
  assert.equal(r2.handled, true);
  assert.match(r2.replacement_id, /^IC-R-\d{8}-[A-Z0-9]{5}$/);
  assert.equal(supabase.inserted.length, 1);
  const repl = supabase.inserted[0];
  assert.equal(repl.source, 'replacement');
  assert.equal(repl.status, 'replacement_pending');
  assert.equal(repl.amount_paise, 0);
  assert.equal(repl.shipment_payment_type, 'prepaid');
  assert.equal(repl.cart_items[0]._replacement.original_order_id, 'IC-20261020-AAAAA');
  assert.equal(repl.customer_address, '12 Lake Road, Kolkata, West Bengal - 700029');
  const orig = supabase.db.orders.find(r => r.id === 'uuid-1');
  assert.equal(orig.rto_offer_state, 'reship');
  assert.equal(orig.rto_reship_order_id, r2.replacement_id);
  assert.equal(alerts.length, 1);

  // A second YES finds no open offer and creates nothing.
  const r3 = await reship.handleOfferReply(deps, '919876543210', 'yes');
  assert.equal(r3.handled, false);
  assert.equal(supabase.inserted.length, 1);
});

test('a new address in chat is used for the re-shipment', async () => {
  const supabase = fakeSupabase([sent({ rto_offer_state: 'confirm_address' })]);
  const deps = { supabase };
  const r = await reship.handleOfferReply(deps, '9876543210', 'Flat 3B, Sunrise Apts, MG Road, Pune, Maharashtra 411001 mobile 9988776655');
  assert.equal(r.handled, true);
  assert.match(r.reply, /411001/);
  assert.match(r.reply, /9988776655/);
  await reship.handleOfferReply(deps, '9876543210', 'YES');
  assert.match(supabase.inserted[0].customer_address, /Pune/);
  assert.equal(supabase.inserted[0].customer_phone, '9988776655');
});

test('NO records the refund choice; other questions go to the AI', async () => {
  const supabase = fakeSupabase([sent()]);
  const q = await reship.handleOfferReply({ supabase }, '9876543210', 'why did it come back?');
  assert.equal(q.handled, false);
  const r = await reship.handleOfferReply({ supabase }, '9876543210', 'No, refund me');
  assert.equal(r.handled, true);
  assert.match(r.reply, /₹425/);
  assert.equal(supabase.db.orders[0].rto_offer_state, 'refund');
  assert.equal(supabase.inserted.length, 0);
});

test('a refund already started closes the offer', async () => {
  const supabase = fakeSupabase([sent({ refund_state: 'AUTO_CLAIMED' })]);
  const r = await reship.handleOfferReply({ supabase }, '9876543210', 'yes');
  assert.equal(r.handled, false);
  assert.equal(supabase.inserted.length, 0);
});

test('refund hold: 48 h from back-with-us while the offer is open', () => {
  const now = Date.parse('2026-10-25T10:00:00Z');
  assert.equal(reship.refundHold(order(), now).hold, false);                                   // never offered
  assert.equal(reship.refundHold(sent({ rto_offer_state: 'refund' }), now).hold, false);        // said NO
  const first = reship.refundHold(sent(), now);
  assert.equal(first.hold, true);
  assert.equal(first.markBack, true);
  assert.equal(reship.refundHold(sent({ rto_back_at: '2026-10-24T10:00:00Z' }), now).hold, true);
  assert.equal(reship.refundHold(sent({ rto_back_at: '2026-10-23T09:59:00Z' }), now).hold, false);
  assert.equal(reship.refundHold(sent({ rto_offer_state: 'reshipping' }), now).hold, true);
});
