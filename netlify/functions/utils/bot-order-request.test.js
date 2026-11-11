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

test('a chat order during the festive sale is full price: the coupon is picked on the website', async () => {
  const db = fakeDb();
  const festive = new Date('2026-10-28T08:00:00Z');
  let amount = 0;
  const { d } = deps(db, {
    now: () => festive,
    priceBooksList: async () => ({ items: [], subtotalRs: 500, shippingRs: 40, totalRs: 540, totalPaise: 54000, unmatched: [] }),
    createPaymentLink: async (o) => { amount = o.amountPaise; return { short_url: 'https://rzp.io/x', id: 'plink_1' }; },
  });
  const drafted = await draftOrderRequest(d, PHONE, { ...ARGS, payment_mode: 'prepaid' });
  // Prepaid above ₹399 ships free (utils/free-delivery); FESTIVE7 is opt-in.
  assert.equal(drafted.summary.sale_discount_rs, undefined);
  assert.equal(drafted.summary.total_rs, 500);
  db.table[0].created_at = festive.toISOString();
  const yes = await confirmDraftOrder(d, PHONE, 'confirm');
  assert.equal(amount, 50000);
  assert.doesNotMatch(yes.reply, /Diwali Sale/);
});

test('a COD chat order still pays shipping below ₹499; prepaid above ₹399 does not', async () => {
  for (const [mode, total] of [['cod', 490], ['prepaid', 450]]) {
    const db = fakeDb();
    const { d } = deps(db, {
      now: () => new Date('2026-10-25T08:00:00Z'),
      priceBooksList: async () => ({ items: [], subtotalRs: 450, shippingRs: 40, totalRs: 490, totalPaise: 49000, unmatched: [] }),
    });
    const drafted = await draftOrderRequest(d, PHONE, { ...ARGS, payment_mode: mode });
    assert.equal(drafted.summary.total_rs, total, mode);
  }
});

test('a chat order with a free-delivery book ships free', async () => {
  const db = fakeDb();
  db.from = ((orig) => (t) => t === 'product_free_delivery'
    ? { select: () => ({ or: async () => ({ data: [{ slug: 'free-book' }], error: null }) }) }
    : orig(t))(db.from);
  const { d } = deps(db, {
    priceBooksList: async () => ({ items: [{ slug: 'free-book', price: 250 }], subtotalRs: 250, shippingRs: 40, totalRs: 290, totalPaise: 29000, unmatched: [] }),
  });
  const drafted = await draftOrderRequest(d, PHONE, ARGS);
  assert.equal(drafted.summary.shipping_rs, 0);
  assert.equal(drafted.summary.total_rs, 250);
  assert.equal(drafted.summary.free_delivery, true);
  const yes = await confirmDraftOrder(d, PHONE, 'confirm');
  assert.match(yes.reply, /₹250 \(books ₹250 · free delivery/);
});

test('₹399 of books is not above ₹399, so no sale', async () => {
  const db = fakeDb();
  const { d } = deps(db, {
    now: () => new Date('2026-10-25T08:00:00Z'),
    priceBooksList: async () => ({ items: [], subtotalRs: 399, shippingRs: 40, totalRs: 439, totalPaise: 43900, unmatched: [] }),
  });
  const drafted = await draftOrderRequest(d, PHONE, ARGS);
  assert.equal(drafted.summary.total_rs, 439);
  assert.equal(drafted.summary.sale_discount_rs, undefined);
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

// ── Confirmed COD → Orders (owner, 3 Nov 2026) ──────────────────────────────
test('YES on a COD draft pushes it to Orders once and tells the owner', async () => {
  const db = fakeDb();
  const pushed = [];
  const { d, sent } = deps(db, { pushOrder: async (row) => { pushed.push(row); return { ok: true, order_id: row.order_id }; } });
  const drafted = await draftOrderRequest(d, PHONE, ARGS);
  const yes = await confirmDraftOrder(d, PHONE, 'confirm');
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].order_id, drafted.order_id);
  assert.equal(pushed[0].payment_mode, 'cod');
  assert.equal(yes.pushed_order_id, drafted.order_id);
  assert.match(sent[0], /Pushed to Orders as/);
  assert.equal(await confirmDraftOrder(d, PHONE, 'confirm'), null);
  assert.equal(pushed.length, 1, 'a second YES pushes nothing');
});

test('prepaid is not pushed on YES: it waits for the payment', async () => {
  const db = fakeDb();
  let pushes = 0;
  const { d } = deps(db, { pushOrder: async () => { pushes++; return { ok: true }; } });
  await draftOrderRequest(d, PHONE, { ...ARGS, payment_mode: 'prepaid' });
  await confirmDraftOrder(d, PHONE, 'confirm');
  assert.equal(pushes, 0);
});

test('bulk or unpriced COD orders are held for a person', async () => {
  for (const [priced, why] of [
    [{ items: [{ title: 'Who Moved My Cheese', qty: 60, unitPrice: 99, price: 5940 }], copies: 60, subtotalRs: 5940, shippingRs: 0, totalRs: 5940, totalPaise: 594000, unmatched: [] }, /bulk order of 60 copies/],
    [{ items: [{ title: 'Some Rare Book', qty: 1, unitPrice: 349, price: 349 }], copies: 1, subtotalRs: 349, shippingRs: 40, totalRs: 389, totalPaise: 38900, unmatched: ['Some Rare Book'] }, /PRICE NEEDED/],
  ]) {
    const db = fakeDb();
    let pushes = 0;
    const { d, sent } = deps(db, { priceBooksList: async () => priced, pushOrder: async () => { pushes++; return { ok: true }; } });
    await draftOrderRequest(d, PHONE, ARGS);
    const yes = await confirmDraftOrder(d, PHONE, 'confirm');
    assert.equal(pushes, 0);
    assert.equal(yes.placed, true, 'still placed as a request');
    assert.match(sent[0], why);
  }
});

test('a failed push still places the request and says so to the owner', async () => {
  const db = fakeDb();
  const { d, sent } = deps(db, { pushOrder: async () => ({ ok: false, error: 'Order exists' }) });
  await draftOrderRequest(d, PHONE, ARGS);
  const yes = await confirmDraftOrder(d, PHONE, 'confirm');
  assert.equal(yes.placed, true);
  assert.equal(db.table[0].status, 'new');
  assert.match(sent[0], /Auto-push failed: Order exists/);
});

test('the draft summary reads back copies per title', async () => {
  const db = fakeDb();
  const { d } = deps(db, { priceBooksList: async () => ({ items: [{ title: 'Ikigai', matchedTitle: 'Ikigai', qty: 2, unitPrice: 250, price: 500 }], copies: 2, subtotalRs: 500, shippingRs: 0, totalRs: 500, totalPaise: 50000, unmatched: [] }) });
  const out = await draftOrderRequest(d, PHONE, { ...ARGS, books: 'Ikigai ×2' });
  assert.deepEqual(out.summary.items, [{ title: 'Ikigai', copies: 2, price_each_rs: 250, line_rs: 500 }]);
  assert.equal(out.summary.total_rs, 500);
});

// ── Unlisted titles are never priced by a guess (4 Nov 2026, IC-W-20261031-4VZFO) ──
const unlistedPricing = async () => ({
  items: [{ title: 'Designing Data-Intensive Applications', qty: 1, unitPrice: 349, price: 349, matched: false }],
  copies: 1, subtotalRs: 349, shippingRs: 40, totalRs: 389, totalPaise: 38900, unmatched: ['Designing Data-Intensive Applications'],
});

test('an unlisted title gets no price in the draft, and the model is told not to quote one', async () => {
  const db = fakeDb();
  const { d } = deps(db, { priceBooksList: unlistedPricing });
  const out = await draftOrderRequest(d, PHONE, { ...ARGS, books: 'Designing Data-Intensive Applications' });
  assert.equal(out.price_unknown, true);
  assert.equal(out.summary.total_rs, undefined);
  assert.doesNotMatch(JSON.stringify(out.summary), /349|389/);
  assert.match(out.message, /Do NOT quote/);
  assert.equal(db.table[0].amount_paise, null);
});

test('YES on an unlisted title places a price-needed request: no amount, no push, no payment link', async () => {
  for (const mode of ['cod', 'prepaid']) {
    const db = fakeDb();
    let pushes = 0, links = 0;
    const { d, sent } = deps(db, {
      priceBooksList: unlistedPricing,
      pushOrder: async () => { pushes++; return { ok: true }; },
      createPaymentLink: async () => { links++; return { short_url: 'x', id: 'y' }; },
    });
    await draftOrderRequest(d, PHONE, { ...ARGS, payment_mode: mode, books: 'Designing Data-Intensive Applications' });
    const yes = await confirmDraftOrder(d, PHONE, 'confirm');
    assert.equal(yes.placed, true);
    assert.equal(db.table[0].status, 'new');
    assert.equal(pushes + links, 0, mode);
    assert.doesNotMatch(yes.reply, /₹/);
    assert.match(yes.reply, /message you the exact price/);
    assert.match(sent[0], /PRICE NEEDED/);
  }
});

const { authorMatchingName, buildRequestEdit } = require('./bot-order-request');

test('the 4 Nov case: the author of the requested book is not taken as the customer', () => {
  assert.equal(authorMatchingName('Sanjay Kishore Kaul', 'Without Fear or Favour by Sanjay Kaul', null), 'Sanjay Kaul');
  const pricing = { items: [{ matchedAuthor: 'Sanjay Kishan Kaul, Jay Vinayak Ojha' }] };
  assert.equal(authorMatchingName('Sanjay Kaul', 'Without Fear or Favour', pricing), 'Sanjay Kishan Kaul');
  assert.equal(authorMatchingName('Sanjay', 'Without Fear or Favour by Sanjay Kaul', null), 'Sanjay Kaul');
});

test('an ordinary customer is not stopped by sharing one name with the author', () => {
  assert.equal(authorMatchingName('Arvind Chaudhary', 'Without Fear or Favour by Sanjay Kaul', null), '');
  assert.equal(authorMatchingName('Sanjay Sharma', 'Without Fear or Favour by Sanjay Kaul', null), '');
  assert.equal(authorMatchingName('Rahul Verma', 'Ikigai, Atomic Habits', { items: [{ matchedAuthor: 'James Clear' }] }), '');
});

const editOf = (over = {}) => ({ customer_name: 'Arvind Chaudhary', address: 'Flat 20, Sector 28, Rohini, Delhi 110089', books: 'Without Fear or Favour', amount_rupees: '₹549', payment_mode: 'cod', notes: '', ...over });

test('an admin edit saves the corrected fields and the amount in paise', () => {
  assert.deepEqual(buildRequestEdit({ status: 'new', payment_mode: 'cod', amount_paise: null }, editOf()).values, {
    customer_name: 'Arvind Chaudhary', address: 'Flat 20, Sector 28, Rohini, Delhi 110089', books: 'Without Fear or Favour', notes: '', payment_mode: 'cod', amount_paise: 54900,
  });
  assert.equal(buildRequestEdit({ status: 'new', payment_mode: 'cod', amount_paise: 54900 }, editOf({ amount_rupees: '' })).values.amount_paise, null);
});

test('an admin edit is refused once pushed, on bad input, or against a sent payment link', () => {
  assert.equal(buildRequestEdit({ status: 'ordered', order_pushed_id: 'IC-W-1' }, editOf()).code, 409);
  assert.equal(buildRequestEdit({ status: 'new' }, editOf({ customer_name: '' })).code, 400);
  assert.equal(buildRequestEdit({ status: 'new' }, editOf({ address: 'Delhi' })).code, 400);
  assert.equal(buildRequestEdit({ status: 'new' }, editOf({ amount_rupees: 'abc' })).code, 400);
  const linked = { status: 'new', payment_mode: 'prepaid', amount_paise: 54900, payment_link: 'https://rzp.io/x' };
  assert.equal(buildRequestEdit(linked, editOf({ payment_mode: 'prepaid', amount_rupees: '499' })).code, 409);
  assert.ok(buildRequestEdit(linked, editOf({ payment_mode: 'prepaid', customer_name: 'New Name' })).values);
});


test('a draft under the author\'s name is not saved until the customer says it is theirs', async () => {
  const db = fakeDb();
  const deps = { db, priceBooksList: async () => ({ items: [{ matched: true, unitPrice: 549, price: 549, qty: 1, matchedAuthor: 'Sanjay Kishan Kaul' }], subtotalRs: 549, shippingRs: 0, totalRs: 549, totalPaise: 54900, unmatched: [] }), now: () => NOW };
  const args = { ...ARGS, customer_name: 'Sanjay Kishore Kaul', books: 'Without Fear or Favour' };
  const stopped = await draftOrderRequest(deps, PHONE, args);
  assert.equal(stopped.error, 'name_matches_author');
  assert.equal(db.calls.inserts, 0);
  const own = await draftOrderRequest(deps, PHONE, { ...args, name_confirmed: true });
  assert.equal(own.needs_confirmation, true);
  assert.equal(db.calls.inserts, 1);
});

// ── Same book on an active order (4 Nov 2026 double payment) ─────────────────
{
  const { activeOrdersContext, sameTitle, requestedTitles } = require('./bot-order-request');
  const ACTIVE = {
    razorpay_order_id: 'IC-20261104-HARDZ', status: 'paid', amount_paise: 23900, created_at: '2026-11-04T17:10:00Z',
    cart_items: [{ title: 'Fractured Communities: Adivasi Histories and the Politics of Power', qty: 1 }],
  };
  // bot_order_requests comes from the shared fake; orders from these rows.
  const withOrders = (base, orders, { fail = false } = {}) => ({
    ...base,
    from(table) {
      if (table !== 'orders') return base.from(table);
      const b = {
        select() { return b; }, or() { return b; }, in() { return b; }, gte() { return b; }, order() { return b; },
        limit() { return Promise.resolve(fail ? { data: null, error: { message: 'down' } } : { data: orders, error: null }); },
      };
      return b;
    },
  });
  const ask = (books, extra = {}) => ({ customer_name: 'Rakshith B K', address: '12 MG Road, Bengaluru 560001', books, payment_mode: 'prepaid', ...extra });
  const phone = '919916401419';

  test('asks before drafting when an active order holds the same book, even by a short title', async () => {
    const db = withOrders(fakeDb(), [ACTIVE]);
    const out = await draftOrderRequest(deps(db).d, phone, ask('Fractured Communities'));
    assert.equal(out.ok, false);
    assert.equal(out.error, 'same_book_active');
    assert.equal(out.order_id, 'IC-20261104-HARDZ');
    assert.match(out.message, /SECOND copy/);
    assert.equal(db.table.length, 0);
  });

  test('a confirmed second copy goes through to the normal YES step', async () => {
    const db = withOrders(fakeDb(), [ACTIVE]);
    const out = await draftOrderRequest(deps(db).d, phone, ask('Fractured Communities', { second_copy_confirmed: true }));
    assert.equal(out.needs_confirmation, true);
    assert.equal(db.table.length, 1);
  });

  test('a different book is not held up', async () => {
    const db = withOrders(fakeDb(), [ACTIVE]);
    const out = await draftOrderRequest(deps(db).d, phone, ask('Atomic Habits'));
    assert.equal(out.needs_confirmation, true);
  });

  test('one clashing title in a longer list is enough to ask', async () => {
    const db = withOrders(fakeDb(), [ACTIVE]);
    const out = await draftOrderRequest(deps(db).d, phone, ask('Atomic Habits, Fractured Communities ×2'));
    assert.equal(out.error, 'same_book_active');
  });

  test('a failed read of orders never stops a customer ordering', async () => {
    const db = withOrders(fakeDb(), [ACTIVE], { fail: true });
    const out = await draftOrderRequest(deps(db).d, phone, ask('Fractured Communities'));
    assert.equal(out.needs_confirmation, true);
  });

  test('editing a draft they already agreed to does not ask again', async () => {
    const db = withOrders(fakeDb(), [ACTIVE]);
    const first = deps(db).d;
    await draftOrderRequest(first, phone, ask('Fractured Communities', { second_copy_confirmed: true }));
    const out = await draftOrderRequest(first, phone, ask('Fractured Communities', { address: '99 New Road, Bengaluru 560002' }));
    assert.equal(out.needs_confirmation, true);
    assert.equal(db.table.length, 1);
  });

  test('the context block names the active order and says a failed attempt does not affect it', async () => {
    const text = await activeOrdersContext(withOrders(fakeDb(), [ACTIVE]), phone, new Date(NOW));
    assert.match(text, /IC-20261104-HARDZ/);
    assert.match(text, /Fractured Communities/);
    assert.match(text, /₹239/);
    assert.match(text, /failed payment/);
    assert.equal(await activeOrdersContext(withOrders(fakeDb(), []), phone, new Date(NOW)), '');
    assert.equal(await activeOrdersContext(withOrders(fakeDb(), [], { fail: true }), phone, new Date(NOW)), '');
  });

  test('title matching tolerates short forms and quantities, not other books', () => {
    assert.ok(sameTitle('Fractured Communities', ACTIVE.cart_items[0].title));
    assert.ok(!sameTitle('Atomic Habits', ACTIVE.cart_items[0].title));
    assert.deepEqual(requestedTitles('Atomic Habits ×2, Ikigai x3\nDune'), ['Atomic Habits', 'Ikigai', 'Dune']);
  });
}

test('a book whose page was taken down: nothing is saved and the bot is told it is not available', async () => {
  const db = fakeDb();
  const removedPricing = async () => ({ items: [], subtotalRs: 349, shippingRs: 40, totalRs: 389, totalPaise: 38900, unmatched: ['The Secret'], removed: ['The Secret'] });
  const { d } = deps(db, { priceBooksList: removedPricing });
  const out = await draftOrderRequest(d, PHONE, ARGS);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'book_not_available');
  assert.deepEqual(out.not_available, ['The Secret']);
  assert.match(out.message, /not available/);
  assert.equal(db.table.length, 0);
  const { autoPushHold } = require('./bot-order-request');
  assert.match(autoPushHold({ removed: ['The Secret'], unmatched: ['The Secret'], items: [] }), /taken down/);
});
