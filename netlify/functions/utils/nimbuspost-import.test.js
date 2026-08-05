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
