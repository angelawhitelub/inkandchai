const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// Stub the catalogue so the tests do not need Supabase or ALL_BOOKS.json.
const CATALOGUE = {
  'the 7 habits of highly effective people': { title: 'The 7 Habits of Highly Effective People by  Stephen', price: 179, slug: 'the-7-habits-87837', author: '' },
  'king of gluttony': { title: 'King of Gluttony - Kings of Sin Book 6 by Ana Huang', price: 299, slug: 'king-of-gluttony-ah', author: 'Ana Huang' },
  'hitchhiker guide galaxy': { title: "The Hitchhiker's Guide to the Galaxy", price: 169, slug: 'hitchhiker-18141', author: '' },
  'strange case jekyll hyde': { title: 'The Strange Case of Dr. Jekyll & Mr. Hyde', price: 134, slug: 'jekyll-81725', author: '' },
  'system design interview vol 1': { title: 'System Design Interview vol-1', price: 199, slug: 'sdi-1', author: '' },
  'vol 2 system design interview': { title: 'Vol 2 System Design Interview', price: 199, slug: 'sdi-2', author: '' },
  'caraval trilogy': { title: 'Caraval Trilogy by Stephanie Garber', price: 699, slug: 'caraval-29309', author: 'Stephanie Garber' },
};
const key = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
// Stand-in for the real fuzzy matcher: every significant word of the catalogue
// key must appear in what the customer typed. Good enough to exercise this
// module, which cares about the arithmetic rather than the matching.
const STOP = new Set(['the', 'of', 'a', 'by', 'and', 'to']);
function findBook(raw) {
  const words = new Set(key(raw).split(' '));
  for (const [k, v] of Object.entries(CATALOGUE)) {
    const need = k.split(' ').filter(w => !STOP.has(w));
    if (need.every(w => words.has(w))) return v;
  }
  return null;
}

const origResolve = Module._resolveFilename;
const stubPath = require.resolve('../../netlify/functions/utils/book-lookup.js');
require.cache[stubPath] = {
  id: stubPath, filename: stubPath, loaded: true, exports: {
    lookupBook: async (raw) => findBook(raw),
    priceBooksList: async () => ({}),
  },
};

const {
  priceAgainstPayment, applyRecoveredDetails, looksLikeAddress,
  splitTitles, splitQty, isAwaitingDetails,
} = require('../../netlify/functions/utils/order-detail-recovery');

const order = (over = {}) => ({ razorpay_order_id: 'IC-X', status: 'paid', amount_paise: 21900, cart_items: [], ...over });

function fakeSupabase() {
  const calls = [];
  return {
    calls,
    from() {
      return {
        update(patch) {
          calls.push(patch);
          const eq = () => ({
            select: () => ({ maybeSingle: async () => ({ data: { ...order(), ...patch }, error: null }) }),
          });
          return { eq };
        },
      };
    },
  };
}

test('an order with no line items is the one awaiting details', () => {
  assert.strictEqual(isAwaitingDetails(order()), true);
  assert.strictEqual(isAwaitingDetails(order({ cart_items: [{ title: 'x' }] })), false);
  // A cancelled or refunded order is not waiting for anything.
  assert.strictEqual(isAwaitingDetails(order({ status: 'cancelled' })), false);
});

test('a single book that matches the payment exactly is accepted', async () => {
  const r = await priceAgainstPayment('7 Habits of highly effective people', order());
  assert.strictEqual(r.reconciles, true);
  assert.strictEqual(r.goodsRs, 179);
  assert.strictEqual(r.shippingRs, 40);
  assert.strictEqual(r.expectedRs, 219);
  assert.strictEqual(r.cart[0].title, 'The 7 Habits of Highly Effective People by  Stephen');
});

test('two books in a numbered list reconcile', async () => {
  const r = await priceAgainstPayment(
    '1. The Hitchhiker\'s Guide to the Galaxy 2. The Strange Case of Dr. Jekyll & Mr. Hyde',
    order({ amount_paise: 34300 }));
  assert.strictEqual(r.cart.length, 2);
  assert.strictEqual(r.expectedRs, 343);
  assert.strictEqual(r.reconciles, true);
});

test('free shipping above the threshold is applied, not a flat ₹40', async () => {
  const r = await priceAgainstPayment('Caraval Trilogy', order({ amount_paise: 69900 }));
  assert.strictEqual(r.shippingRs, 0);
  assert.strictEqual(r.reconciles, true);
});

test('a partial COD order reconciles against the 10% deposit, not the full price', async () => {
  const r = await priceAgainstPayment(
    'System Design Interview vol-1, Vol 2 System Design Interview',
    order({ status: 'partial_cod_pending', amount_paise: 4400 }));
  assert.strictEqual(r.fullTotalRs, 438);
  assert.strictEqual(r.expectedRs, 44);
  assert.strictEqual(r.reconciles, true);
  // The balance the courier must collect rides on the first item.
  assert.deepStrictEqual(r.cart[0]._payment,
    { mode: 'partial_cod', rate: 0.10, balance: 394, deposit: 44, full_total: 438 });
});

test('a book that costs the wrong amount is refused', async () => {
  // Right title, but this customer paid ₹339 — so it is not what they bought.
  const r = await priceAgainstPayment('7 Habits of highly effective people', order({ amount_paise: 33900 }));
  assert.strictEqual(r.reconciles, false);
  assert.match(r.reason, /₹219\.00 but ₹339\.00 was paid/);
});

test('an unknown title is refused rather than guessed at', async () => {
  const r = await priceAgainstPayment('some book I forgot the name of', order());
  assert.strictEqual(r.reconciles, false);
  assert.match(r.reason, /none of the titles matched/);
});

test('an address needs a pincode before it is accepted', () => {
  assert.strictEqual(looksLikeAddress('575, Sector 45, Faridabad, Haryana 121010').ok, true);
  assert.strictEqual(looksLikeAddress('Hari Nagar, New Delhi').ok, false);
  assert.match(looksLikeAddress('Hari Nagar, New Delhi').reason, /pincode/);
  assert.strictEqual(looksLikeAddress('yes').ok, false);
});

test('quantities are read from either side of the x', () => {
  assert.deepStrictEqual(splitQty('2x Atomic Habits'), { qty: 2, title: 'Atomic Habits' });
  assert.deepStrictEqual(splitQty('Atomic Habits x 3'), { qty: 3, title: 'Atomic Habits' });
  assert.deepStrictEqual(splitQty('Atomic Habits'), { qty: 1, title: 'Atomic Habits' });
});

test('a books list survives commas, newlines and numbering', () => {
  assert.deepStrictEqual(splitTitles('A, B\nC'), ['A', 'B', 'C']);
  assert.deepStrictEqual(splitTitles('1. A 2. B'), ['A', 'B']);
});

test('a good address is saved even when the books cannot be verified', async () => {
  const sb = fakeSupabase();
  const out = await applyRecoveredDetails(sb, order(), {
    address: '575, Sector 45, Faridabad, Haryana 121010',
    books: 'a book whose name I cannot recall',
  });
  assert.strictEqual(out.address_saved, true);
  assert.strictEqual(out.books_saved, false);
  assert.strictEqual(out.needs_review, true);
  // Crucially: no cart was written, so nothing can be shipped by mistake.
  assert.deepStrictEqual(Object.keys(sb.calls[0]), ['customer_address']);
});

test('a fully verified reply writes both halves', async () => {
  const sb = fakeSupabase();
  const out = await applyRecoveredDetails(sb, order(), {
    address: 'WZ-40A, Hari Nagar, New Delhi 110064',
    books: '7 Habits of highly effective people',
  });
  assert.strictEqual(out.address_saved, true);
  assert.strictEqual(out.books_saved, true);
  assert.strictEqual(out.needs_review, false);
  assert.deepStrictEqual(Object.keys(sb.calls[0]).sort(), ['cart_items', 'customer_address']);
});

test('a failed write is never reported as success', async () => {
  const sb = { from: () => ({ update: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'connection refused' } }) }) }) }) }) };
  const out = await applyRecoveredDetails(sb, order(), {
    address: 'WZ-40A, Hari Nagar, New Delhi 110064',
    books: '7 Habits of highly effective people',
  });
  assert.strictEqual(out.address_saved, false);
  assert.strictEqual(out.books_saved, false);
  assert.match(out.reason, /connection refused/);
});

test('nothing is written when the customer supplied neither half', async () => {
  const sb = fakeSupabase();
  const out = await applyRecoveredDetails(sb, order(), {});
  assert.strictEqual(sb.calls.length, 0);
  assert.strictEqual(out.address_saved, false);
});

Module._resolveFilename = origResolve;

// The bot pushes the recovered order to NimbusPost the moment both halves
// verify. It must push the row as saved — the copy it started with still has
// the empty address and cart the outage left behind.
test('the saved row comes back so a push does not use the stale copy', async () => {
  const sb = fakeSupabase();
  const out = await applyRecoveredDetails(sb, order(), {
    address: 'WZ-40A, Hari Nagar, New Delhi 110064',
    books: '7 Habits of highly effective people',
  });
  assert.strictEqual(out.address_saved, true);
  assert.strictEqual(out.books_saved, true);
  assert.ok(out.order, 'expected the updated row back');
  assert.match(out.order.customer_address, /Hari Nagar/);
  assert.strictEqual(out.order.cart_items.length, 1);
  assert.match(out.order.cart_items[0].title, /7 Habits/i);
});

test('a failed write hands back no row, so nothing can be pushed', async () => {
  const sb = { from: () => ({ update: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'connection refused' } }) }) }) }) }) };
  const out = await applyRecoveredDetails(sb, order(), {
    address: 'WZ-40A, Hari Nagar, New Delhi 110064',
    books: '7 Habits of highly effective people',
  });
  assert.strictEqual(out.order, undefined);
});
