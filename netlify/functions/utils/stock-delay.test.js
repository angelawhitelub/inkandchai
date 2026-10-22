'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.URL = 'https://inkandchai.in';

// order-help reads one order through Supabase; the double records updates.
const DB = { order: null, updates: [] };
const file = require.resolve('@supabase/supabase-js');
require.cache[file] = {
  id: file, filename: file, loaded: true,
  exports: {
    createClient: () => ({
      from: () => {
        let patch = null;
        const q = {
          select: () => q, eq: () => q,
          is: (c, v) => { q._is = [c, v]; return q; },
          maybeSingle: async () => ({ data: DB.order, error: null }),
          update: (p) => { patch = p; return q; },
          then: (ok, bad) => {
            let res = { data: [], error: null };
            if (patch) {
              const free = DB.order && !DB.order.cancellation_requested_at;
              if (free) { Object.assign(DB.order, patch); DB.updates.push(patch); res = { data: [{ id: DB.order.id }], error: null }; }
            }
            return Promise.resolve(res).then(ok, bad);
          },
        };
        return q;
      },
    }),
  },
};

const sd = require('./stock-delay');
const { _test: job } = require('../stock-delay-notify-scheduled');
const help = require('../order-help');

const NOW = Date.parse('2026-10-10T07:00:00Z');
const order = (over = {}) => ({
  id: 'u1', razorpay_order_id: 'IC-20261006-AAAAA', status: 'shipped', created_at: '2026-10-06T06:00:00Z',
  customer_name: 'Riya Sharma', customer_phone: '9876543210', tracking_id: '7D1', courier_name: 'DTDC',
  amount_paise: 64800,
  cart_items: [
    { title: 'Ikigai', slug: 'ikigai', qty: 1, price: 249 },
    { title: 'The Witch', url: '/product/the-witch/', qty: 1, price: 399 },
  ],
  ...over,
});
const row = (over = {}) => ({ id: 'u1', bucket: 'awaiting_pickup', replacement: null, courier_cancelled: false, ...over });

test('only a booked, unpicked, 3-day-old, open, non-replacement order without a request is due', () => {
  assert.equal(sd.skipReason(row(), order(), NOW), null);
  assert.match(sd.skipReason(row({ bucket: 'not_booked' }), order(), NOW), /not booked/);
  assert.match(sd.skipReason(row({ replacement: { original_order_id: 'X' } }), order(), NOW), /replacement/);
  assert.match(sd.skipReason(row({ courier_cancelled: true }), order(), NOW), /voided/);
  assert.match(sd.skipReason(row(), order({ created_at: '2026-10-08T06:00:00Z' }), NOW), /3 days/);
  assert.match(sd.skipReason(row(), order({ cancellation_requested_at: '2026-10-09T00:00:00Z' }), NOW), /already requested/);
});

test('names the sold-out book, else the only book, else "one of the books"', () => {
  assert.equal(sd.bookPhrase(order(), new Set(['the-witch'])), '"The Witch"');
  assert.equal(sd.bookPhrase(order({ cart_items: [{ title: 'Ikigai', slug: 'ikigai' }] }), new Set()), '"Ikigai"');
  assert.equal(sd.bookPhrase(order(), new Set()), 'one of the books in your order');
  const m = sd.messageFor(order(), new Set(['ikigai', 'the-witch']));
  assert.match(m.text, /"Ikigai" and "The Witch" are out of stock with us and with our supplier/);
});

test('the message offers removing the book only when there is more than one, and carries a signed link', () => {
  const two = sd.messageFor(order(), new Set(['the-witch']));
  assert.ok(two.canRemove);
  assert.match(two.text, /remove just that book/);
  assert.match(two.link, /^https:\/\/inkandchai\.in\/order-help\/\?o=IC-20261006-AAAAA&k=[\w-]{24}$/);
  assert.deepEqual(two.params, ['Riya', 'IC-20261006-AAAAA', '"The Witch"']);
  const one = sd.messageFor(order({ cart_items: [{ title: 'Ikigai', slug: 'ikigai' }] }), new Set());
  assert.equal(one.canRemove, false);
  assert.doesNotMatch(one.text, /remove/);
  const k = two.link.split('k=')[1];
  assert.ok(sd.verifyToken('IC-20261006-AAAAA', k));
  assert.ok(sd.verifyToken('ic-20261006-aaaaa', k), 'case-insensitive order id');
  assert.equal(sd.verifyToken('IC-20261006-BBBBB', k), false);
  assert.equal(sd.verifyToken('IC-20261006-AAAAA', k.slice(0, -1) + 'x'), false);
});

// ── the job ─────────────────────────────────────────────────────────────────
function fakeKv(init = {}) {
  const store = new Map(Object.entries(init));
  return { store, get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } };
}
function deps({ orders, rows, live, kv = fakeKv(), sold = new Set() }) {
  const db = { from: () => { const q = { select: () => q, in: async (c, ids) => ({ data: ids.map((id) => ({ id, customer_email: `${id}@example.com` })), error: null }) }; return q; } };
  return {
    db, kv,
    listNotPicked: async () => ({ orders, rows }),
    checkPickups: async (os) => new Map(os.map((o) => [o.id, { state: live[o.id] || 'unknown' }])),
    soldOutSlugs: async () => sold,
  };
}

test('the courier must say "still waiting"; already-notified and moved orders are left alone', async () => {
  const orders = [
    order({ id: 'a', razorpay_order_id: 'IC-A' }),
    order({ id: 'b', razorpay_order_id: 'IC-B' }),
    order({ id: 'c', razorpay_order_id: 'IC-C' }),
    order({ id: 'd', razorpay_order_id: 'IC-D' }),
  ];
  const rows = orders.map((o) => row({ id: o.id }));
  const kv = fakeKv({ [job.SENT_KEY]: JSON.stringify({ 'IC-D': new Date().toISOString() }) });
  const r = await job.run({ dryRun: true }, deps({ orders, rows, kv, live: { a: 'waiting', b: 'moved', c: 'unknown', d: 'waiting' } }));
  assert.deepEqual(r.orders.map((o) => o.order), ['IC-A']);
  assert.equal(r.skipped['courier says moved'], 1);
  assert.equal(r.skipped['courier did not answer'], 1);
  assert.equal(r.skipped['already notified'], 1);
});

test('sends email + WhatsApp, falls back to plain text, and remembers who was told', async () => {
  const orders = [order({ id: 'a', razorpay_order_id: 'IC-A' })];
  const d = deps({ orders, rows: [row({ id: 'a' })], live: { a: 'waiting' }, sold: new Set(['the-witch']) });
  const sent = [];
  d.sendEmail = async (m) => { sent.push(['email', m.to, m.subject]); return { ok: true }; };
  d.sendWhatsApp = async (m) => { sent.push(['template', m.template, m.params, m.urlButtonParam]); return { ok: false }; };
  d.sendText = async (to, text) => { sent.push(['text', to, text]); return { ok: true }; };
  const r = await job.run({ dryRun: false }, d);
  assert.equal(r.notified, 1);
  assert.equal(r.results[0].whatsapp, 'text');
  assert.deepEqual(sent[0], ['email', 'a@example.com', 'Your order IC-A: a book is out of stock']);
  assert.equal(sent[1][1], 'order_stock_delay');
  assert.match(sent[1][3], /^\?o=IC-A&k=/);
  assert.match(sent[2][2], /"The Witch" is out of stock/);
  assert.ok(JSON.parse(d.kv.store.get(job.SENT_KEY))['IC-A']);

  // Next run: told once only.
  const again = await job.run({ dryRun: true }, { ...d, listNotPicked: async () => ({ orders, rows: [row({ id: 'a' })] }) });
  assert.equal(again.due, 0);
});

test('an unreadable sent list stops the run rather than messaging everyone again', async () => {
  const kv = { get: async () => '{broken', put: async () => {} };
  await assert.rejects(job.run({ dryRun: true }, deps({ orders: [], rows: [], live: {}, kv })), /sent list unreadable/);
});

// ── the request endpoint ────────────────────────────────────────────────────
const call = (method, input) => help.handler(method === 'GET'
  ? { httpMethod: 'GET', queryStringParameters: input }
  : { httpMethod: 'POST', body: JSON.stringify(input) }).then((r) => ({ status: r.statusCode, ...JSON.parse(r.body) }));

test('the link is the credential: a wrong signature sees nothing', async () => {
  DB.order = order();
  const r = await call('GET', { o: 'IC-20261006-AAAAA', k: 'x'.repeat(24) });
  assert.equal(r.status, 403);
  assert.equal(r.books, undefined);
});

test('remove-a-book records a request only, once, and a moved parcel cannot be changed', async () => {
  DB.order = order(); DB.updates = [];
  const k = sd.messageFor(DB.order, new Set()).link.split('k=')[1];
  const view = await call('GET', { o: 'IC-20261006-AAAAA', k });
  assert.equal(view.can_remove_book, true);
  assert.equal(view.books.length, 2);

  const r = await call('POST', { o: 'IC-20261006-AAAAA', k, action: 'remove_book', book: 1 });
  assert.equal(r.status, 200);
  assert.equal(DB.updates.length, 1);
  assert.match(DB.updates[0].cancellation_request_note, /REMOVE "The Witch" \(₹399\)/);
  assert.match(DB.updates[0].cancellation_request_note, /rebook/);
  assert.equal(DB.order.status, 'shipped', 'status untouched');
  assert.equal(DB.order.cart_items.length, 2, 'books untouched');

  const twice = await call('POST', { o: 'IC-20261006-AAAAA', k, action: 'cancel_order' });
  assert.equal(twice.status, 409);

  DB.order = order({ last_courier_status: 'In Transit' }); DB.updates = [];
  const moved = await call('POST', { o: 'IC-20261006-AAAAA', k, action: 'cancel_order' });
  assert.equal(moved.status, 409);
  assert.match(moved.error, /already been picked up/);
  assert.equal(DB.updates.length, 0);

  // "not picked up" is not movement.
  DB.order = order({ last_courier_status: 'Not Picked' });
  const stillOpen = await call('GET', { o: 'IC-20261006-AAAAA', k });
  assert.equal(stillOpen.open, true);
});
