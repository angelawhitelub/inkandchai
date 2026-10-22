'use strict';

// Returns were retired in favour of replacements. These pin the two endpoints:
// request-return refuses, request-replacement accepts the new reasons, the
// Track Order page's email/phone proof, and a chosen subset of books.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const FN = path.join(__dirname, '..');
const sent = { email: [], wa: [] };

function stub(rel, exports) {
  const file = require.resolve(path.join(FN, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

// A small stand-in for the supabase query builder over one `orders` table.
function fakeSupabase(state) {
  const from = () => {
    const q = { filters: [], insert: null };
    const api = {
      select() { return api; },
      eq(k, v) { q.filters.push((r) => String(k === 'cart_items->0->_replacement->>original_order_id' ? r.cart_items?.[0]?._replacement?.original_order_id : r[k]) === String(v)); return api; },
      ilike(k, v) {
        const re = new RegExp('^' + String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i');
        q.filters.push((r) => re.test(typeof r[k] === 'string' ? r[k] : JSON.stringify(r[k] || '')));
        return api;
      },
      limit() { return api; },
      insert(row) { q.insert = row; return api; },
      single() { return api.maybeSingle(); },
      maybeSingle() {
        if (q.insert) { state.orders.push(q.insert); return Promise.resolve({ data: q.insert, error: null }); }
        return Promise.resolve({ data: state.orders.find((r) => q.filters.every((f) => f(r))) || null, error: null });
      },
      then(res, rej) {
        return Promise.resolve({ data: state.orders.filter((r) => q.filters.every((f) => f(r))), error: null }).then(res, rej);
      },
    };
    return api;
  };
  return {
    from,
    auth: { getUser: async () => ({ data: { user: null }, error: new Error('no') }) },
    storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: 'https://x/p.jpg' } }) }) },
  };
}

let state;
test.beforeEach(() => require('../../../worker/shims/runtime-bindings').bindEnv({
  CUSTOMER_CLAIMS: { idFromName: n => n, get: () => ({ fetch: async () => Response.json({ allowed:true }) }) },
}));
const photo = 'data:image/png;base64,' + Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(210)]).toString('base64');
stub('../../node_modules/@supabase/supabase-js', { createClient: () => fakeSupabase(state) });
stub('utils/email', { sendEmail: async (m) => { sent.email.push(m); return {}; } });
stub('utils/whatsapp', { sendWhatsApp: async (m) => { sent.wa.push(m); return {}; }, sendText: async () => ({}) });

process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_KEY = 'test';
const replacement = require('../request-replacement');
const ret = require('../request-return');

function order(extra = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111', razorpay_order_id: 'IC-20260928-ABCDE', status: 'delivered',
    delivered_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    customer_name: 'Asha Rao', customer_email: 'asha@example.com', customer_phone: '+91 98765 43210', customer_address: 'Delhi',
    cart_items: [{ title: 'Book One', qty: 1, _payment: { mode: 'prepaid' } }, { title: 'Book Two', qty: 2 }],
    ...extra,
  };
}
const call = (body) => replacement.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) });
const base = { original_order_id: 'IC-20260928-ABCDE', reason: 'defective', note: 'Pages 40 to 56 are blank', photos: [photo] };

test('request-return refuses new returns', async () => {
  const res = await ret.handler({ httpMethod: 'POST', headers: {}, body: '{}' });
  assert.equal(res.statusCode, 410);
  assert.equal(JSON.parse(res.body).replacement_only, true);
});

test('Track Order proof: the email or phone on the order is enough, anything else is refused', async () => {
  state = { orders: [order()] };
  assert.equal((await call({ ...base })).statusCode, 401, 'no session and no proof');
  assert.equal((await call({ ...base, q: 'someone@else.com' })).statusCode, 403);
  const ok = await call({ ...base, q: '98765 43210' });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.match(JSON.parse(ok.body).replacement_order_id, /^IC-R-/);
});

test('only the picked books are re-shipped, capped at the quantity ordered', async () => {
  state = { orders: [order()] };
  const res = await call({ ...base, reason: 'wrong_book', q: 'ASHA@example.com', items: [{ title: 'book two', qty: 9 }] });
  assert.equal(res.statusCode, 200, res.body);
  const repl = state.orders.find((o) => o.source === 'replacement');
  assert.deepEqual(repl.cart_items.map((i) => [i.title, i.qty]), [['Book Two', 2]]);
  assert.equal(repl.cart_items[0]._replacement.reason_label, 'Wrong book delivered');
  assert.equal(repl.amount_paise, 0);
});

test('a book that is not on the order is refused', async () => {
  state = { orders: [order()] };
  const res = await call({ ...base, q: 'asha@example.com', items: [{ title: 'Some Other Book', qty: 1 }] });
  assert.equal(res.statusCode, 400);
  assert.equal(state.orders.length, 1, 'nothing created');
});

test('the 7-day window and the delivered status still hold', async () => {
  state = { orders: [order({ delivered_at: new Date(Date.now() - 8 * 86400000).toISOString() })] };
  assert.equal((await call({ ...base, q: 'asha@example.com' })).statusCode, 400);
  state = { orders: [order({ status: 'shipped' })] };
  assert.equal((await call({ ...base, q: 'asha@example.com' })).statusCode, 400);
});

test('a replacement on a different order does not disqualify this customer', async () => {
  state = { orders: [order(), { razorpay_order_id: 'IC-R-20260901-ZZZZZ', source: 'replacement', customer_email: 'asha@example.com', customer_phone: '', cart_items: [] }] };
  const res = await call({ ...base, q: 'asha@example.com' });
  assert.equal(res.statusCode, 200, res.body);
});

test('an unknown reason is refused', async () => {
  state = { orders: [order()] };
  assert.equal((await call({ ...base, reason: 'changed_my_mind', q: 'asha@example.com' })).statusCode, 400);
});

test('a prior replacement for this original order is refused', async () => {
  state = { orders: [order(), { source: 'replacement', razorpay_order_id: 'IC-R-OLD', cart_items: [{ _replacement: { original_order_id: base.original_order_id } }] }] };
  assert.equal((await call({ ...base, q: 'asha@example.com' })).statusCode, 409);
});
test('photo evidence is required for the logged-out Track Order flow', async () => {
  state = { orders: [order()] };
  assert.equal((await call({ ...base, q: 'asha@example.com', photos: [] })).statusCode, 400);
  assert.equal(state.orders.length, 1);
});
