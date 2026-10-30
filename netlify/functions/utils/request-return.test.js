'use strict';

// 7-day returns from My Orders (request-return), the refund for the books
// picked, and the refund or store credit on receipt (return-auto-refund).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const FN = path.join(__dirname, '..');
const sent = { email: [], wa: [], text: [], fetch: [] };
function stub(rel, exports) {
  const file = require.resolve(path.join(FN, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

// supabase-js over in-memory tables, for the calls these two files make.
function fakeDb(state) {
  const from = (table) => {
    const rows = () => (state[table] = state[table] || []);
    const q = { filters: [], patch: null, insert: null, limit: Infinity };
    const match = (r) => q.filters.every((f) => f(r));
    const run = () => {
      if (q.insert) { const row = { id: 'ret-' + (rows().length + 1), created_at: new Date().toISOString(), ...q.insert }; rows().push(row); return [row]; }
      const hit = rows().filter(match).slice(0, q.limit);
      if (q.patch) hit.forEach((r) => Object.assign(r, q.patch));
      return hit;
    };
    const api = {
      select() { return api; },
      eq(k, v) {
        q.filters.push((r) => String(k === 'cart_items->0->_replacement->>original_order_id'
          ? r.cart_items?.[0]?._replacement?.original_order_id : r[k]) === String(v));
        return api;
      },
      in(k, vs) { q.filters.push((r) => vs.map(String).includes(String(r[k]))); return api; },
      is(k, v) { q.filters.push((r) => (r[k] ?? null) === v); return api; },
      limit(n) { q.limit = n; return api; },
      update(p) { q.patch = p; return api; },
      insert(row) { q.insert = row; return api; },
      single() { return api.maybeSingle(); },
      maybeSingle() { return Promise.resolve({ data: run()[0] || null, error: null }); },
      then(res, rej) { return Promise.resolve({ data: run(), error: null }).then(res, rej); },
    };
    return api;
  };
  return {
    from,
    auth: { getUser: async (t) => (t === 'good' ? { data: { user: { email: 'asha@example.com' } }, error: null } : { data: {}, error: new Error('no') }) },
  };
}

let state;
stub('../../node_modules/@supabase/supabase-js', { createClient: () => fakeDb(state) });
stub('utils/email', { sendEmail: async (m) => { sent.email.push(m); return {}; } });
stub('utils/whatsapp', { sendWhatsApp: async (m) => { sent.wa.push(m); return { ok: true }; }, sendText: async (to, t) => { sent.text.push(t); return {}; } });
stub('utils/razorpay-refund', { issueRazorpayRefund: async (pay, paise) => ({ id: 'rfnd_' + paise }) });
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_KEY = 'test';
process.env.ADMIN_SECRET = 'admin';
global.fetch = async (url, init) => { sent.fetch.push({ url: String(url), body: init && init.body }); return { status: 202, ok: true }; };

const ret = require('../request-return');
const { handleReturnAwbDelivered } = require('./return-auto-refund');
const { pickReturnItems } = require('./return-refund');

const ORDER_ID = '11111111-1111-1111-1111-111111111111';
function order(extra = {}) {
  return {
    id: ORDER_ID, razorpay_order_id: 'IC-20261020-ABCDE', status: 'delivered',
    delivered_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    customer_name: 'Asha Rao', customer_email: 'asha@example.com', customer_phone: '+91 98765 43210', customer_address: 'Delhi 110006',
    razorpay_payment_id: 'pay_1', amount_paise: 64000,
    cart_items: [{ title: 'Book One', qty: 1, price: 400, _payment: { mode: 'prepaid' } }, { title: 'Book Two', qty: 2, price: 100 }],
    ...extra,
  };
}
const call = (body, token = 'good') => ret.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ order_id: ORDER_ID, refund_method: 'original', ...body }) });
test.beforeEach(() => { for (const k of Object.keys(sent)) sent[k].length = 0; });

test('returning the whole order refunds everything paid, delivery included', () => {
  const p = pickReturnItems(order(), []);
  assert.equal(p.whole, true);
  assert.equal(p.refundPaise, 64000);
});

test('returning some books refunds their share of what was paid', () => {
  const p = pickReturnItems(order(), [{ title: 'book two', qty: 9 }]);
  assert.equal(p.whole, false);
  assert.deepEqual(p.items.map((i) => [i.title, i.qty]), [['Book Two', 2]]);
  assert.equal(p.refundPaise, Math.round(64000 * 200 / 600));
  assert.equal(pickReturnItems(order(), [{ title: 'Not On It' }]).ok, false);
  const missing = order({ cart_items: [{ title: 'Book One', qty: 1, price: 400, _missing: true }, { title: 'Book Two', qty: 1, price: 100 }] });
  assert.equal(pickReturnItems(missing, [{ title: 'Book One' }]).ok, false, 'a book reported missing is not on the parcel');
});

test('a return is recorded, the pickup is booked, and nothing is paid yet', async () => {
  state = { orders: [order()] };
  const res = await call({ items: [{ title: 'Book One', qty: 1 }] });
  assert.equal(res.statusCode, 200, res.body);
  const row = state.return_requests[0];
  assert.equal(row.status, 'approved');
  assert.equal(row.refund_status, 'awaiting_return_delivery');
  assert.equal(row.refund_amount_paise, Math.round(64000 * 400 / 600));
  assert.deepEqual(row.items.map((i) => i.title), ['Book One']);
  assert.ok(sent.fetch.some((f) => /auto-return-pickup-background/.test(f.url)), 'pickup booked');
  const mail = sent.email.find((m) => m.to === 'asha@example.com');
  assert.match(mail.subject, /Return request received/);
  assert.match(JSON.parse(res.body).message, /as soon as the courier accepts/);
});

const codOrder = (mode = 'cod') => order({ razorpay_payment_id: null, cart_items: [{ title: 'Book One', qty: 1, price: 400, _payment: { mode } }] });

test('store credit is not handed out at request time', async () => {
  state = { orders: [codOrder()] };
  const res = await call({});
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(state.return_requests[0].refund_status, 'awaiting_return_delivery');
  assert.equal(state.scratch_cards, undefined);
});

test('out of the window, undelivered, a replacement, or already replaced: refused', async () => {
  state = { orders: [order({ delivered_at: new Date(Date.now() - 8 * 86400000).toISOString() })] };
  assert.equal((await call({})).statusCode, 400);
  state = { orders: [order({ status: 'shipped' })] };
  assert.equal((await call({})).statusCode, 400);
  state = { orders: [order({ source: 'replacement' })] };
  assert.equal((await call({})).statusCode, 400);
  state = { orders: [order(), { id: 'r', source: 'replacement', razorpay_order_id: 'IC-R-1', cart_items: [{ _replacement: { original_order_id: 'IC-20261020-ABCDE' } }] }] };
  assert.equal((await call({})).statusCode, 409);
  assert.equal((await call({}, 'bad')).statusCode, 401);
  assert.equal(state.return_requests, undefined);
});

test('COD and partial COD returns are store credit only; prepaid goes back to the original method', async () => {
  for (const mode of ['cod', 'partial_cod']) {
    state = { orders: [codOrder(mode)] };
    const res = await call({ refund_method: 'original', upi_id: 'asha@ybl' });   // an older page's choice is ignored
    assert.equal(res.statusCode, 200, res.body);
    const row = state.return_requests[0];
    assert.equal(row.refund_method, 'wallet', mode);
    assert.equal(row.refund_status, 'awaiting_return_delivery', mode);
    assert.equal(row.upi_id, undefined);
    assert.match(JSON.parse(res.body).message, /store credit/);
  }
  state = { orders: [order()] };
  const res = await call({ refund_method: 'wallet' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(state.return_requests[0].refund_method, 'original');
  assert.match(JSON.parse(res.body).message, /original payment method/);
});

test('one return per order', async () => {
  state = { orders: [order()] };
  assert.equal((await call({})).statusCode, 200);
  assert.equal((await call({})).statusCode, 400);
});

test('on receipt: a prepaid return is refunded, and store credit is minted, once', async () => {
  state = { orders: [order()], return_requests: [
    { id: 'a', order_id: ORDER_ID, awb: 'AWB1', status: 'pickup_scheduled', refund_method: 'original', payment_type: 'prepaid', refund_status: 'awaiting_return_delivery', refund_amount_paise: 42667, customer_email: 'asha@example.com' },
    { id: 'b', order_id: ORDER_ID, awb: 'AWB2', status: 'pickup_scheduled', refund_method: 'wallet', payment_type: 'cod', refund_status: 'awaiting_return_delivery', refund_amount_paise: 30000, customer_email: 'asha@example.com', created_at: '2026-10-25T10:00:00Z' },
    { id: 'c', order_id: ORDER_ID, awb: 'AWB3', status: 'pickup_scheduled', refund_method: 'original', payment_type: 'cod', refund_status: 'manual_payout_pending', refund_amount_paise: 30000 },
  ] };
  const db = fakeDb(state);
  const a = await handleReturnAwbDelivered(db, 'AWB1');
  assert.equal(a.refunded, true);
  assert.equal(state.return_requests[0].refund_status, 'refunded');
  assert.equal(state.return_requests[0].refund_ref, 'rfnd_42667');

  const b = await handleReturnAwbDelivered(db, 'AWB2');
  assert.equal(b.provider, 'wallet');
  assert.equal(state.return_requests[1].refund_status, 'wallet_issued');
  assert.equal(state.scratch_cards.length, 1);
  assert.equal(state.scratch_cards[0].value_paise, 30000 + 5000, 'requested before the bonus ended: refund + ₹50 bonus');
  assert.ok(sent.email.some((m) => m.html.includes(state.scratch_cards[0].code)));

  assert.equal((await handleReturnAwbDelivered(db, 'AWB2')).matched, false, 'never twice');
  assert.equal((await handleReturnAwbDelivered(db, 'AWB3')).matched, false, 'a COD payout stays manual');
  assert.equal(state.scratch_cards.length, 1);
});

test('the ₹50 store-credit bonus ended on 30 Oct 2026: a COD return now gets exactly what was paid', async () => {
  const { walletBonusRupees } = require('./return-refund');
  assert.equal(walletBonusRupees('2026-10-29T18:00:00Z'), 50, 'promised before it ended');
  assert.equal(walletBonusRupees('2026-10-30T02:00:00Z'), 0);
  assert.equal(walletBonusRupees(''), 0);

  state = { orders: [codOrder()] };
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-10-31T09:00:00Z');
  let res;
  try { res = await call({}); } finally { Date.now = realNow; }
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.wallet_rupees, Math.round(64000 / 100), 'no bonus on top');
  assert.doesNotMatch(body.message, /bonus/);
  assert.doesNotMatch(sent.email.find((m) => m.to === 'asha@example.com').html, /bonus/);

  state = { orders: [order()], return_requests: [
    { id: 'n', order_id: ORDER_ID, awb: 'AWB9', status: 'pickup_scheduled', refund_method: 'wallet', payment_type: 'cod', refund_status: 'awaiting_return_delivery', refund_amount_paise: 30000, customer_email: 'asha@example.com', created_at: '2026-10-31T09:00:00Z' },
  ] };
  assert.equal((await handleReturnAwbDelivered(fakeDb(state), 'AWB9')).provider, 'wallet');
  assert.equal(state.scratch_cards[0].value_paise, 30000, 'credit = what was paid');
});
