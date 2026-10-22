const test = require('node:test');
const assert = require('node:assert/strict');
const { rebuildOrderBooks, parseBooksList, isSettled } = require('./order-books-rebuild');

// Real catalogue prices, as returned by lookupBook.
const CATALOGUE = {
  'the forty rules of love': { title: 'The Forty Rules of Love by Elif Shafak', price: 161.1 },
  'atomic habits': { title: 'Atomic Habits', price: 179 },
  'ikigai': { title: '(Hindi) Ikigai', price: 179 },
};
const lookup = async (t) => CATALOGUE[String(t).toLowerCase()] || null;

// IC-W-20260805-6OCA8 as it stood: one book at ₹161.10 + ₹40 shipping = ₹201.
const codOrder = (extra) => ({
  status: 'cod_pending',
  amount_paise: 20100,
  razorpay_payment_id: null,
  advance_paid_paise: 0,
  cart_items: [{ title: 'The Forty Rules of Love', qty: 1, price: 201 }],
  ...extra,
});

test('parses quantities and bare titles', () => {
  assert.deepEqual(parseBooksList('Ikigai ×2, Sapiens'), [
    { title: 'Ikigai', qty: 2, explicitQty: true },
    { title: 'Sapiens', qty: 1, explicitQty: false },
  ]);
});

test('prices from the catalogue instead of dividing the total', async () => {
  const r = await rebuildOrderBooks('The Forty Rules of Love ×3', codOrder(), lookup);
  // Was ₹67 each (₹201 / 3). Now the real price.
  assert.equal(r.cartItems[0].price, 161.1);
  assert.equal(r.cartItems[0].qty, 3);
  assert.equal(r.unpriced.length, 0);
});

test('moves the total so an unpaid COD collects the right amount', async () => {
  const r = await rebuildOrderBooks('The Forty Rules of Love ×3', codOrder(), lookup);
  // 3 × 161.10 = 483.30, under ₹499 so ₹40 shipping applies.
  assert.deepEqual(r.repriced, { from: 201, to: 523.3 });
  assert.equal(r.amountPaise, 52330);
});

test('drops shipping once the basket clears the free-shipping floor', async () => {
  const r = await rebuildOrderBooks('Atomic Habits ×3', codOrder(), lookup);
  assert.equal(r.repriced.to, 537);   // 3 × 179, no shipping
});

test('never rewrites the total on an order that was already paid', async () => {
  for (const paid of [
    { razorpay_payment_id: 'pay_123' },
    { status: 'paid' },
    { status: 'partial_cod_pending', advance_paid_paise: 8000 },
    { status: 'partially_refunded' },
  ]) {
    const r = await rebuildOrderBooks('The Forty Rules of Love ×3', codOrder(paid), lookup);
    assert.equal(r.amountPaise, null, JSON.stringify(paid));
    assert.equal(r.repriced, null);
    assert.match(r.warning, /already paid/);
    // The lines are still corrected — only the money is left alone.
    assert.equal(r.cartItems[0].price, 161.1);
  }
});

test('falls back to splitting the total only when the catalogue misses', async () => {
  const r = await rebuildOrderBooks('Some Untracked Zine ×3', codOrder(), lookup);
  assert.equal(r.cartItems[0].price, 67);   // 201 / 3, the old behaviour
  assert.deepEqual(r.unpriced, ['Some Untracked Zine']);
  assert.match(r.warning, /Not found in the catalogue/);
});

test('a typo fix with no quantity keeps what the customer was charged', async () => {
  const order = codOrder({ cart_items: [{ title: 'Mystery Chapbook', qty: 1, price: 250 }] });
  const r = await rebuildOrderBooks('Mystery Chapbook', order, lookup);
  assert.equal(r.cartItems[0].price, 250);
});

test('uses the catalogue title, so the bot typo does not reach the label', async () => {
  const r = await rebuildOrderBooks('Atomic Habits ×1', codOrder(), lookup);
  assert.equal(r.cartItems[0].title, 'Atomic Habits');
});

test('a lookup failure degrades instead of throwing', async () => {
  const boom = async () => { throw new Error('catalogue down'); };
  const r = await rebuildOrderBooks('Anything ×2', codOrder(), boom);
  assert.equal(r.cartItems[0].price, 101);   // 201 / 2
  assert.equal(r.unpriced.length, 1);
});

test('knows which orders have money on them', () => {
  assert.equal(isSettled({ status: 'cod_pending' }), false);
  assert.equal(isSettled({ status: 'confirmed' }), false);
  assert.equal(isSettled({ status: 'paid' }), true);
  assert.equal(isSettled({ status: 'shipped', razorpay_payment_id: 'pay_1' }), true);
  assert.equal(isSettled({ status: 'shipped', advance_paid_paise: 5000 }), true);
});

// IC-CW-20261001-Y830C: a 10% partial-COD order whose address was corrected.
// The form resends the prefilled books, and the rebuild kept only
// title/qty/price, so the ₹395 balance vanished and the panel push sent 0.
const partialOrder = () => ({
  status: 'partial_cod_pending',
  amount_paise: 4400,
  razorpay_payment_id: 'pay_x',
  advance_paid_paise: 0,
  cart_items: [{
    id: '/product/mirror/', slug: 'mirror', qty: 1, price: 399,
    title: 'The Mirror of Infinite Endings', author: 'Stephanie Garber',
    _payment: { mode: 'partial_cod', rate: 0.1, balance: 395, deposit: 44, full_total: 439 },
    _offer_id: 'cp-mirror', _publisher_sourced: true,
  }],
});

test('the unchanged prefilled list leaves cart_items alone', async () => {
  const order = partialOrder();
  const r = await rebuildOrderBooks(' the mirror of  infinite endings ', order, lookup);
  assert.equal(r.unchanged, true);
  assert.equal(r.amountPaise, null);
  assert.equal(r.cartItems, order.cart_items);
});

test('a real edit keeps the partial-COD balance and the line\'s own fields', async () => {
  const r = await rebuildOrderBooks('The Mirror of Infinite Endings ×2, Atomic Habits', partialOrder(), lookup);
  assert.equal(r.unchanged, false);
  assert.equal(r.cartItems[0]._payment.balance, 395);
  assert.equal(r.cartItems[0]._offer_id, 'cp-mirror');
  assert.equal(r.cartItems[0].slug, 'mirror');
  assert.equal(r.cartItems[0].qty, 2);
  assert.equal(r.cartItems[1]._payment, undefined);
  assert.equal(r.amountPaise, null, 'part-paid, so the total is not rewritten');
});

test('the payment terms move to the new first line when the book is swapped', async () => {
  const r = await rebuildOrderBooks('Atomic Habits', partialOrder(), lookup);
  assert.equal(r.cartItems[0].title, 'Atomic Habits');
  assert.equal(r.cartItems[0]._payment.balance, 395);
});
