const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DRAFT, sameBooks, draftReplyDecision, draftOrderRequest, confirmDraftOrder, botOrdersContext,
} = require('./bot-order-request');

// The 18 Sep case: one customer, one book set, three requests in three minutes
// (IC-W-20260918-ETSJ6, -4YK6C, -N6Q3W) because the bot placed on every turn.
const PHONE = '917013427850';
const NOW = new Date('2026-09-18T13:00:00Z');
const ARGS = {
  customer_name: 'Gavvala Surya Prakash',
  address: '8/236 Masidukatta, Narpala 515425',
  books: 'System Design Interview Vol 1, Vol 2 by Alex Xu',
  payment_mode: 'cod',
};

// An in-memory bot_order_requests table behind enough of the Supabase builder.
function fakeDb(rows = []) {
  const table = rows.map((r) => ({ ...r }));
  const calls = { inserts: 0, updates: 0 };
  const from = () => {
    const q = { op: 'select', filters: [], returning: false };
    const match = (r) => q.filters.every(([op, c, v]) =>
      op === 'eq' ? r[c] === v : op === 'gte' ? String(r[c]) >= v : true);
    const b = {
      select() { if (q.op === 'update') q.returning = true; return b; },
      eq(c, v) { q.filters.push(['eq', c, v]); return b; },
      gte(c, v) { q.filters.push(['gte', c, v]); return b; },
      order() { return b; }, limit() { return b; },
      insert(row) { calls.inserts++; table.push({ id: `id${table.length + 1}`, ...row }); return Promise.resolve({ error: null }); },
      update(row) { q.op = 'update'; q.row = row; return b; },
      maybeSingle() { return Promise.resolve({ data: table.find(match) || null, error: null }); },
      then(ok, bad) {
        if (q.op === 'update') {
          const hit = table.filter(match);
          hit.forEach((r) => Object.assign(r, q.row));
          calls.updates++;
          return Promise.resolve({ data: q.returning ? hit.map((r) => ({ id: r.id })) : null, error: null }).then(ok, bad);
        }
        const out = table.filter(match).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
        return Promise.resolve({ data: out, error: null }).then(ok, bad);
      },
    };
    return b;
  };
  return { from, table, calls };
}

const pricing = async () => ({ items: [], subtotalRs: 398, shippingRs: 40, totalRs: 438, totalPaise: 43800, unmatched: [] });

function deps(db, extra = {}) {
  const sent = [];
  return {
    sent,
    d: {
      db, priceBooksList: pricing, now: () => NOW,
      createPaymentLink: async () => ({ short_url: 'https://rzp.io/x', id: 'plink_1' }),
      upsertBotCustomer: async () => {},
      notifyOwner: async (t) => { sent.push(t); },
      ...extra,
    },
  };
}

test('the tool drafts the order; nothing is placed and the owner is not pinged', async () => {
  const db = fakeDb();
  const { d, sent } = deps(db);
  const out = await draftOrderRequest(d, PHONE, ARGS);
  assert.equal(out.needs_confirmation, true);
  assert.equal(out.summary.total_rs, 438);
  assert.equal(db.table.length, 1);
  assert.equal(db.table[0].status, DRAFT);
  assert.equal(db.table[0].customer_phone, '7013427850');
  assert.equal(sent.length, 0);
});

test('calling the tool again revises the same draft instead of adding one', async () => {
  const db = fakeDb();
  const { d } = deps(db);
  const first = await draftOrderRequest(d, PHONE, ARGS);
  const second = await draftOrderRequest(d, PHONE, { ...ARGS, payment_mode: 'prepaid' });
  assert.equal(db.table.length, 1);
  assert.equal(second.order_id, first.order_id);
  assert.equal(db.table[0].payment_mode, 'prepaid');
});

test('YES places the draft exactly once, with the order id and total', async () => {
  const db = fakeDb();
  const { d, sent } = deps(db);
  const drafted = await draftOrderRequest(d, PHONE, ARGS);
  const yes = await confirmDraftOrder(d, PHONE, 'confirm');
  assert.equal(yes.placed, true);
  assert.match(yes.reply, new RegExp(drafted.order_id));
  assert.match(yes.reply, /₹438/);
  assert.equal(db.table[0].status, 'new');
  assert.ok(db.table[0].customer_confirmed_at, 'confirmed, so the 5-minute "still on?" ping is skipped');
  assert.equal(sent.length, 1, 'owner pinged once');

  // A second YES (or the same YES delivered twice) finds no draft and falls through.
  assert.equal(await confirmDraftOrder(d, PHONE, 'confirm'), null);
  assert.equal(sent.length, 1);
});

test('prepaid gets its payment link only after YES', async () => {
  const db = fakeDb();
  let links = 0;
  const { d } = deps(db, { createPaymentLink: async () => { links++; return { short_url: 'https://rzp.io/x', id: 'plink_1' }; } });
  await draftOrderRequest(d, PHONE, { ...ARGS, payment_mode: 'prepaid' });
  assert.equal(links, 0);
  const yes = await confirmDraftOrder(d, PHONE, 'confirm');
  assert.equal(links, 1);
  assert.match(yes.reply, /https:\/\/rzp\.io\/x/);
  assert.equal(db.table[0].razorpay_payment_link_id, 'plink_1');
});

test('NO discards the draft and places nothing', async () => {
  const db = fakeDb();
  const { d, sent } = deps(db);
  await draftOrderRequest(d, PHONE, ARGS);
  const no = await confirmDraftOrder(d, PHONE, 'cancel');
  assert.equal(no.handled, true);
  assert.equal(db.table[0].status, 'draft_discarded');
  assert.equal(sent.length, 0);
});

test('a YES long after the summary places nothing', async () => {
  const db = fakeDb();
  const { d } = deps(db);
  await draftOrderRequest(d, PHONE, ARGS);
  const later = { ...d, now: () => new Date(NOW.getTime() + 3 * 60 * 60 * 1000) };
  assert.equal(await confirmDraftOrder(later, PHONE, 'confirm'), null);
  assert.equal(db.table[0].status, DRAFT);
});

test('the same books again return the placed order instead of a new one', async () => {
  const db = fakeDb([{
    id: 'a', order_id: 'IC-W-20260918-ETSJ6', customer_phone: '7013427850', status: 'new',
    books: 'System design interview vol1+vol2 by Alex xu', payment_mode: 'cod', amount_paise: 43800,
    created_at: '2026-09-18T12:58:00.000Z',
  }]);
  const { d } = deps(db);
  for (const books of ['System design interview vol1, System design interview vol2', ARGS.books]) {
    const out = await draftOrderRequest(d, PHONE, { ...ARGS, books });
    assert.equal(out.already_placed, true, books);
    assert.equal(out.order_id, 'IC-W-20260918-ETSJ6');
  }
  assert.equal(db.calls.inserts, 0);
});

test('a different book is drafted, and the existing order is mentioned', async () => {
  const db = fakeDb([{
    id: 'a', order_id: 'IC-W-20260918-ETSJ6', customer_phone: '7013427850', status: 'contacted',
    books: 'System Design Interview Vol 1', created_at: '2026-09-18T12:58:00.000Z',
  }]);
  const { d } = deps(db);
  const out = await draftOrderRequest(d, PHONE, { ...ARGS, books: 'Atomic Habits' });
  assert.equal(out.needs_confirmation, true);
  assert.deepEqual(out.other_open_orders, ['IC-W-20260918-ETSJ6']);
});

test('a closed or cancelled request does not block ordering the same book again', async () => {
  const db = fakeDb([{
    id: 'a', order_id: 'IC-W-20260918-ETSJ6', customer_phone: '7013427850', status: 'closed',
    books: ARGS.books, created_at: '2026-09-18T12:58:00.000Z',
  }]);
  const { d } = deps(db);
  assert.equal((await draftOrderRequest(d, PHONE, ARGS)).needs_confirmation, true);
});

test('same-books matching survives the model rewording titles', () => {
  assert.ok(sameBooks('Protocols: An Operating Manual for the Human Body by Dr. Andrew Huberman', 'Protocols by Andrew Huberman, an operating manual for the human body'));
  assert.ok(sameBooks('System design interview vol1+vol2 by Alex xu', 'System Design Interview Volume 1, Volume 2'));
  assert.ok(!sameBooks('System Design Interview Vol 1', 'System Design Interview Vol 2'));
  assert.ok(!sameBooks('Atomic Habits', 'The Psychology of Money'));
});

test('only a plain yes/no answers the summary; anything longer goes to the assistant', () => {
  for (const t of ['yes', 'YES', 'Yes please', 'haan', 'ok', 'confirm', 'yes, place it', '👍']) {
    assert.equal(draftReplyDecision(t.replace(',', '')), 'confirm', t);
  }
  for (const t of ['no', 'cancel', 'nahi']) assert.equal(draftReplyDecision(t), 'cancel', t);
  for (const t of ['yes but change the address to 12 MG Road', 'is my order placed?', 'ok what is the price']) {
    assert.equal(draftReplyDecision(t), null, t);
  }
});

test('the model is told which orders this number already has', async () => {
  const db = fakeDb([
    { id: 'a', order_id: 'IC-W-20260918-ETSJ6', customer_phone: '7013427850', status: 'new', books: 'SDI Vol 1', amount_paise: 43800, payment_mode: 'cod', created_at: '2026-09-18T12:58:00.000Z' },
    { id: 'b', order_id: 'IC-W-20260918-ZZZZZ', customer_phone: '7013427850', status: 'closed', books: 'Old', created_at: '2026-09-18T12:00:00.000Z' },
  ]);
  const ctx = await botOrdersContext(db, PHONE, NOW);
  assert.match(ctx, /IC-W-20260918-ETSJ6/);
  assert.match(ctx, /placed/);
  assert.doesNotMatch(ctx, /ZZZZZ/);
  assert.equal(await botOrdersContext(fakeDb(), PHONE, NOW), '');
});

test('placeholder and status-query "orders" are still refused before anything is written', async () => {
  const db = fakeDb();
  const { d } = deps(db);
  const out = await draftOrderRequest(d, PHONE, { ...ARGS, books: 'where is my order' });
  assert.equal(out.ok, false);
  assert.equal(db.table.length, 0);
});
