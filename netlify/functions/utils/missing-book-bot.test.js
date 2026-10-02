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

// Photo evidence is required (utils/customer-claim), and a chat cannot supply
// it, so the bot checks the report and sends the customer to the form.
function assertNothingFiled(db, h) {
  assert.equal(db.inserted.length, 0, 'no replacement order');
  assert.equal(db.updated.length, 0, 'the original order is not stamped');
  assert.equal(h.chat.length, 0, 'the tool sends nothing itself');
  assert.equal(h.emails.length, 0);
}

test('a valid missing-book report is sent to the Track Order form for photos, not filed from chat', async () => {
  process.env.STORE_OWNER_EMAIL = 'owner@example.com';
  const db = fakeDb({ messages: said('hi', 'one book missing from my parcel, alchemist nahi aayi'), orders: [order()] });
  const h = harness(db);
  const res = await reportMissingBookViaBot(PHONE, { order_id: 'IC-20260920-ABCDE', books: [{ title: 'the alchemist', qty: 1 }] }, 'PHONE_B', h.deps);

  assert.equal(res.ok, false);
  assert.equal(res.error, 'photos-required', JSON.stringify(res));
  assert.equal(res.order_id, 'IC-20260920-ABCDE');
  assert.match(res.message, /https:\/\/inkandchai\.in\/track\//);
  assert.match(res.message, /No request has been created/);
  assert.doesNotMatch(res.message, /UPI/, 'a prepaid order is not asked for a UPI ID');
  assertNothingFiled(db, h);
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

test('cash on delivery: no UPI ID is collected in chat, the form asks for it', async () => {
  const cod = order({ razorpay_payment_id: null, shipment_payment_type: 'cod' });
  const db = fakeDb({ messages: said('ek book nahi aayi'), orders: [cod] });
  const h = harness(db);
  const res = await reportMissingBookViaBot(PHONE, { books: ['Atomic Habits'] }, null, h.deps);
  assert.equal(res.error, 'photos-required', JSON.stringify(res));
  assert.match(res.message, /form will also ask for their UPI ID/);
  assert.match(res.message, /never in this chat/);
  assertNothingFiled(db, h);
});

test('an order that already has a replacement is not sent to the form again', async () => {
  const existing = { razorpay_order_id: 'IC-R-20260921-OLD01', status: 'replacement_pending', cart_items: [{ title: 'Atomic Habits (Paperback)' }] };
  const db = fakeDb({ messages: said('alchemist missing'), orders: [order()], replacements: [existing] });
  const h = harness(db);
  const res = await reportMissingBookViaBot(PHONE, { books: ['The Alchemist'] }, null, h.deps);
  assert.equal(res.error, 'replacement-exists');
  assert.match(res.message, /only one is allowed per order/);
  assert.match(res.message, /\[ESCALATE\]/);
  assert.doesNotMatch(res.message, /inkandchai\.in\/track/);
  assertNothingFiled(db, h);
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
