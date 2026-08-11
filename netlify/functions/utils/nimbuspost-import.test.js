const test = require('node:test');
const assert = require('node:assert');
const { buildPayload } = require('./nimbuspost-import');

// Regression: IC-20260804-79V71. The Razorpay webhook won the race against the
// browser callback and saved the partial-COD deposit as an ordinary 'paid'
// order, so this builder declared ₹63 prepaid on a ₹625 cart and the courier
// collected nothing. The COD decision must follow the money, not the label.
const partialCart = [
  { title: 'Becoming Supernatural', qty: 1, price: 254.15,
    _payment: { mode: 'partial_cod', full_total: 624.91, deposit: 63, balance: 561.91, rate: 0.1 } },
  { title: 'THE COURAGE TO BE DISLIKED', qty: 1, price: 179 },
  { title: 'Psycho-Cybernetics', qty: 1, price: 191.76 },
];
const base = {
  razorpay_order_id: 'IC-20260804-79V71',
  customer_name: 'Himanshu Bhatt',
  customer_phone: '8601153704',
  customer_address: 'Rauta Par, Marwa nagar rd., Basti, Uttar Pradesh, 272001',
  amount_paise: 6300,
  cart_items: partialCart,
};

test('partial COD collects the balance even when the status says paid', async () => {
  const p = await buildPayload({ ...base, status: 'paid', razorpay_payment_id: 'pay_TLoSS1pq72gRhq' });
  assert.equal(p.payment_method, 'COD');
  assert.equal(p.amount, 562);
});

test('partial COD is COD when the status is correct too', async () => {
  const p = await buildPayload({ ...base, status: 'partial_cod_pending', razorpay_payment_id: 'pay_x' });
  assert.equal(p.payment_method, 'COD');
  assert.equal(p.amount, 562);
});

test('an unpaid order in a non-COD status still ships COD', async () => {
  const p = await buildPayload({ ...base, status: 'confirmed', cart_items: [{ title: 'A', qty: 1, price: 499 }], amount_paise: 49900 });
  assert.equal(p.payment_method, 'COD');
  assert.equal(p.amount, 499);
});

test('a genuinely prepaid order stays prepaid at its full charged amount', async () => {
  const p = await buildPayload({
    ...base, status: 'paid', razorpay_payment_id: 'pay_ok', amount_paise: 62491,
    cart_items: partialCart.map(({ _payment, ...i }) => i),
  });
  assert.equal(p.payment_method, 'prepaid');
  assert.equal(p.amount, 625);
});

// ── Replacements ────────────────────────────────────────────────────────────
// Regression: IC-R-20260808-BG7VM shipped as COD ₹179. A free reshipment has
// amount_paise 0, and the `amountRs || itemSubtotal` fallback read that 0 as
// "missing" and substituted the price the customer had ALREADY paid on the
// original order — so the courier arrived asking them to pay twice for a book
// we'd failed to send. Every replacement in the table had gone out this way.
const replacementCart = [
  { title: 'The Art of Letting Go', qty: 1, price: 179,
    _replacement: { original_order_id: 'IC-20260801-ABCDE', reason: 'missing_item' } },
];
const replBase = {
  razorpay_order_id: 'IC-R-20260808-BG7VM',
  customer_name: 'Sneha Prabhu',
  customer_phone: '8601153704',
  customer_address: 'Rauta Par, Marwa nagar rd., Basti, Uttar Pradesh, 272001',
  amount_paise: 0,
  status: 'replacement_pending',
  source: 'replacement',
  cart_items: replacementCart,
};

test('a free replacement ships prepaid, collecting nothing', async () => {
  const p = await buildPayload(replBase);
  assert.equal(p.payment_method, 'prepaid');
});

test('a free replacement still declares the books\' value on the label', async () => {
  const p = await buildPayload(replBase);
  assert.equal(p.amount, 179);   // declared, not collected
});

test('a replacement with a declared amount is still prepaid', async () => {
  // A replacement amount is parcel value only; it must never be collected.
  const p = await buildPayload({ ...replBase, amount_paise: 5000 });
  assert.equal(p.payment_method, 'prepaid');
  assert.equal(p.amount, 50);
});

test('a replacement of a partial-COD order does not inherit its balance', async () => {
  // The cart is copied from the original, so _payment rides along; without the
  // replacement guard the courier would re-collect ₹561.91.
  const p = await buildPayload({
    ...replBase,
    cart_items: [{ ...replacementCart[0], _payment: partialCart[0]._payment }],
  });
  assert.equal(p.payment_method, 'prepaid');
  assert.equal(p.amount, 179);
});

test('a replacement is recognised from its id alone on legacy rows', async () => {
  const { source, status, ...noMarkers } = replBase;
  const p = await buildPayload({ ...noMarkers, cart_items: [{ title: 'X', qty: 1, price: 249 }] });
  assert.equal(p.payment_method, 'prepaid');
});

test('an ordinary order with no amount still falls back to the subtotal', async () => {
  // The fallback exists for real reasons; only replacements opt out of it.
  const p = await buildPayload({
    ...base, status: 'cod_pending', amount_paise: 0, razorpay_order_id: 'IC-20260808-PLAIN',
    cart_items: [{ title: 'A', qty: 2, price: 150 }],
  });
  assert.equal(p.payment_method, 'COD');
  assert.equal(p.amount, 300);
});
