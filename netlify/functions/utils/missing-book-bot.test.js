const test = require('node:test');
const assert = require('node:assert/strict');
const { matchMissingItems } = require('./missing-book-report');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';
const { reportMissingBookViaBot } = require('../whatsapp-bot')._internal;

const PHONE = '919876543210';

// Enough of the Supabase query builder for the bot tool and the shared report.
function fakeDb({ messages = [], orders = [], replacements = [] } = {}) {
  const inserted = [];
  const updated = [];
  const from = (table) => {
    const q = { op: 'select', filters: [] };
    const rows = () => {
      if (table === 'bot_messages') return messages;
      if (q.filters.some(([c]) => c === 'source')) return replacements;
      return orders;
    };
    const b = {
      select() { return b; }, or() { return b; }, order() { return b; }, limit() { return b; },
      eq(col, val) { q.filters.push([col, val]); return b; },
      update(row) { q.op = 'update'; q.row = row; return b; },
      insert(row) { inserted.push(row); return Promise.resolve({ error: null }); },
      maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
      then(ok, bad) {
        if (q.op === 'update') { updated.push(q); return Promise.resolve({ error: null }).then(ok, bad); }
        return Promise.resolve({ data: rows(), error: null }).then(ok, bad);
      },
    };
    return b;
  };
  return { from, inserted, updated };
}

const said = (...texts) => texts.map((message, i) => ({ role: 'user', message, created_at: `2026-09-28T10:0${i}:00Z` })).reverse();

const order = (over = {}) => ({
  id: 'uuid-1',
  razorpay_order_id: 'IC-20260920-ABCDE',
  razorpay_payment_id: 'pay_1',
  status: 'delivered',
  customer_name: 'Riya Sharma',
  customer_email: 'riya@example.com',
  customer_phone: '9876543210',
  customer_address: '12 MG Road, Pune 411001',
  amount_paise: 89800,
  cart_items: [
    { title: 'Atomic Habits (Paperback)', qty: 1, price: 399 },
    { title: 'The Alchemist', qty: 2, price: 249 },
  ],
  ...over,
});

function harness(db) {
  const chat = [];
  const emails = [];
  const deps = {
    supabase: db,
    sendReply: async (to, text, via) => { chat.push({ to, text, via }); return { ok: true }; },
    persistMessage: async () => {},
    report: {
      sendEmail: async (m) => { emails.push(m); return { ok: true }; },
      sendWhatsApp: async () => { throw new Error('template must not be used in chat'); },
      sendText: async () => { throw new Error('default-number text must not be used in chat'); },
    },
  };
  return { chat, emails, deps };
}

test('creates a free replacement for the missing book and confirms in the same chat', async () => {
  process.env.STORE_OWNER_EMAIL = 'owner@example.com';
  const db = fakeDb({ messages: said('hi', 'one book missing from my parcel, alchemist nahi aayi'), orders: [order()] });
  const h = harness(db);
  const res = await reportMissingBookViaBot(PHONE, { order_id: 'IC-20260920-ABCDE', books: [{ title: 'the alchemist', qty: 1 }] }, 'PHONE_B', h.deps);

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.match(res.replacement_order_id, /^IC-R-\d{8}-[A-Z0-9]{5}$/);
  const row = db.inserted[0];
  assert.equal(row.status, 'replacement_pending');
  assert.equal(row.amount_paise, 0);
  assert.equal(row.shipment_payment_type, 'prepaid');
  assert.deepEqual(row.cart_items.map(i => [i.title, i.qty]), [['The Alchemist', 1]]);
  assert.equal(row.cart_items[0]._replacement.reported_via, 'whatsapp');
  assert.equal(row.cart_items[0]._replacement.original_order_id, 'IC-20260920-ABCDE');

  // The original is stamped, so it shows under Missing Books in admin.
  const stamped = db.updated[0].row.cart_items.find(i => i.title === 'The Alchemist');
  assert.equal(stamped._missing, true);
  assert.equal(stamped._missing_qty, 1);
  assert.equal(stamped._missing_via, 'whatsapp');

  // Customer: one message through the number they wrote to, plus an email.
  assert.equal(h.chat.length, 1);
  assert.equal(h.chat[0].via, 'PHONE_B');
  assert.match(h.chat[0].text, new RegExp(res.replacement_order_id));
  assert.ok(h.emails.some(e => e.to === 'riya@example.com'));
  assert.ok(h.emails.some(e => e.to === 'owner@example.com' && /WhatsApp bot/.test(e.subject)));
});

test('nothing is created unless the customer actually said something is missing', async () => {
  const db = fakeDb({ messages: said('where is my order?'), orders: [order()] });
  const res = await reportMissingBookViaBot(PHONE, { books: ['The Alchemist'] }, null, harness(db).deps);
  assert.equal(res.error, 'no-missing-report');
  assert.equal(db.inserted.length, 0);
});

test('an order that is not delivered yet is not filed', async () => {
  const db = fakeDb({ messages: said('a book is missing'), orders: [order({ status: 'shipped' })] });
  const res = await reportMissingBookViaBot(PHONE, { books: ['The Alchemist'] }, null, harness(db).deps);
  assert.equal(res.error, 'not-delivered');
  assert.equal(db.inserted.length, 0);
});

test('every book "missing" is a delivery dispute, not a free reshipment', async () => {
  const db = fakeDb({ messages: said('books missing, nothing came'), orders: [order()] });
  const res = await reportMissingBookViaBot(PHONE, { books: [{ title: 'Atomic Habits' }, { title: 'The Alchemist', qty: 2 }] }, null, harness(db).deps);
  assert.equal(res.error, 'whole-parcel');
  assert.match(res.message, /\[ESCALATE\]/);
  assert.equal(db.inserted.length, 0);
});

test('an order id from a different phone number is refused', async () => {
  const db = fakeDb({ messages: said('book missing'), orders: [order()] });
  const res = await reportMissingBookViaBot(PHONE, { order_id: 'IC-20260101-ZZZZZ', books: ['The Alchemist'] }, null, harness(db).deps);
  assert.equal(res.error, 'not-found');
  assert.equal(db.inserted.length, 0);
});

test('a title that is not on the order gets the real list back to ask with', async () => {
  const db = fakeDb({ messages: said('book missing'), orders: [order()] });
  const res = await reportMissingBookViaBot(PHONE, { books: ['Ikigai'] }, null, harness(db).deps);
  assert.equal(res.error, 'books-not-on-order');
  assert.match(res.message, /The Alchemist/);
});

test('cash on delivery asks for a UPI ID first, then files with it', async () => {
  const cod = order({ razorpay_payment_id: null, shipment_payment_type: 'cod' });
  const db = fakeDb({ messages: said('ek book nahi aayi'), orders: [cod] });
  const h = harness(db);
  const first = await reportMissingBookViaBot(PHONE, { books: ['Atomic Habits'] }, null, h.deps);
  assert.equal(first.error, 'need_upi');
  assert.equal(db.inserted.length, 0);

  const second = await reportMissingBookViaBot(PHONE, { books: ['Atomic Habits'], upi_id: '9876543210@ybl' }, null, h.deps);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(db.inserted[0].cart_items[0]._replacement.refund_upi_id, '9876543210@ybl');
});

test('a replacement already on file without this book promises nothing', async () => {
  const existing = { razorpay_order_id: 'IC-R-20260921-OLD01', cart_items: [{ title: 'Atomic Habits (Paperback)' }] };
  const db = fakeDb({ messages: said('alchemist missing'), orders: [order()], replacements: [existing] });
  const h = harness(db);
  const res = await reportMissingBookViaBot(PHONE, { books: ['The Alchemist'] }, null, h.deps);
  assert.equal(res.error, 'replacement-exists');
  assert.equal(db.inserted.length, 0);
  assert.doesNotMatch(h.chat[0].text, /IC-R-/);
});

test('loose matching accepts a typed title but not an ambiguous one', () => {
  const o = order({ cart_items: [{ title: 'Atomic Habits (Paperback)', qty: 1 }, { title: 'Harry Potter 1', qty: 1 }, { title: 'Harry Potter 2', qty: 1 }] });
  const { valid, unmatched } = matchMissingItems(o, [{ title: 'atomic habits', qty: null }, { title: 'harry potter', qty: null }], { loose: true });
  assert.deepEqual(valid.map(v => v.title), ['Atomic Habits (Paperback)']);
  assert.deepEqual(unmatched, ['harry potter']);
  // The website picker stays exact.
  assert.equal(matchMissingItems(o, [{ title: 'atomic habits', qty: null }]).valid.length, 0);
});

test('quantity is capped at what was ordered', () => {
  const { valid } = matchMissingItems(order(), [{ title: 'The Alchemist', qty: 5 }]);
  assert.equal(valid[0].qty, 2);
});
