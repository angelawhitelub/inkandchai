const test = require('node:test');
const assert = require('node:assert/strict');
const { _test: { planRelink } } = require('../admin-relink-replacement');

const repl = { razorpay_order_id: 'IC-R-20261005-9BGKR', source: 'replacement', amount_paise: 29415, customer_phone: '9017200016',
  created_at: '2026-10-05T17:46:00Z', cart_items: [{ title: 'Becoming Supernatural', qty: 1, price: 254.15 }] };
const orig = { razorpay_order_id: 'IC-20261001-RXCSK', customer_phone: '+919017200016', created_at: '2026-10-01T22:35:00Z',
  cart_items: [{ title: 'Combo', qty: 1, _missing: true }] };

test('a lost link is restored with the reason from the original, and the total goes back to ₹0', () => {
  const p = planRelink(repl, orig, new Date('2026-11-19T00:00:00Z'));
  assert.equal(p.patch.amount_paise, 0);
  assert.equal(p.patch.cart_items[0]._replacement.original_order_id, 'IC-20261001-RXCSK');
  assert.equal(p.patch.cart_items[0]._replacement.reason, 'missing_item');
  assert.equal(p.patch.cart_items[0].title, 'Becoming Supernatural');
  assert.equal(repl.cart_items[0]._replacement, undefined, 'the input is not mutated');
});

test('wrong pairs are refused', () => {
  assert.match(planRelink(repl, { ...orig, customer_phone: '9811122334' }).error, /different phone/);
  assert.match(planRelink(repl, { ...orig, created_at: '2026-10-06T00:00:00Z' }).error, /before/);
  assert.match(planRelink({ ...repl, source: null, razorpay_order_id: 'IC-20261005-AAAAA' }, orig).error, /not a replacement/);
  assert.match(planRelink({ ...repl, cart_items: [{ title: 'X', _replacement: { original_order_id: 'IC-1' } }] }, orig).error, /already linked/);
  assert.match(planRelink({ ...repl, razorpay_payment_id: 'pay_1' }, orig).error, /payment id/);
  assert.match(planRelink(repl, { ...orig, razorpay_order_id: 'IC-R-1' }).error, /itself a replacement/);
});
