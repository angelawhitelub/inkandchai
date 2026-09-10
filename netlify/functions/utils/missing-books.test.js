const test = require('node:test');
const assert = require('node:assert/strict');
const {
  replacementMeta,
  isMissingBookReplacement,
  missingValuePaise,
  refundSplitPaise,
} = require('./missing-books');

const repl = (reason, items = [{ title: 'A', price: 299, qty: 2 }]) => ({
  source: 'replacement',
  cart_items: items.map((it, i) => (i === 0 ? { ...it, _replacement: { reason, original_order_id: 'IC-1' } } : it)),
});

test('the two reasons that mean a book never arrived are the only ones that count', () => {
  assert.equal(isMissingBookReplacement(repl('missing_item')), true);
  assert.equal(isMissingBookReplacement(repl('incomplete_set')), true);
  // A printing defect is a book the customer does hold, so cancelling its
  // replacement is not "we owe you for something that never came".
  assert.equal(isMissingBookReplacement(repl('missing_pages')), false);
  assert.equal(isMissingBookReplacement(repl('damaged')), false);
  assert.equal(isMissingBookReplacement(repl('wrong_book')), false);
});

test('an order with no replacement metadata is not a missing-book replacement', () => {
  assert.equal(isMissingBookReplacement({ cart_items: [{ title: 'A' }] }), false);
  assert.equal(isMissingBookReplacement({}), false);
  assert.equal(isMissingBookReplacement(null), false);
});

test('the metadata is found wherever in the cart it was written', () => {
  const order = { cart_items: [{ title: 'A' }, { title: 'B', _replacement: { reason: 'missing_item' } }] };
  assert.equal(replacementMeta(order).reason, 'missing_item');
  assert.equal(isMissingBookReplacement(order), true);
});

test('value comes from the carried-over line prices, not the replacement total', () => {
  // A replacement ships free: amount_paise is 0 and would refund nothing.
  assert.equal(missingValuePaise(repl('missing_item')), 59800);
  assert.equal(missingValuePaise(repl('missing_item', [{ title: 'A', price: 100 }])), 10000);
});

test('a line with no usable price or quantity does not poison the total', () => {
  const order = repl('missing_item', [
    { title: 'A', price: 150, qty: 1 },
    { title: 'B', price: null, qty: 3 },
    { title: 'C', price: 50, qty: 0 },
    { title: 'D', price: 'abc', qty: 2 },
  ]);
  // 150 + (unpriced) + 50x1 (qty 0 reads as 1) + (unparseable)
  assert.equal(missingValuePaise(order), 20000);
});

test('pure COD leaves the whole amount to a manual transfer', () => {
  const split = refundSplitPaise(repl('missing_item'), { razorpay_payment_id: '', amount_paise: 0 });
  assert.deepEqual(split, { owedPaise: 59800, gatewayPaise: 0, upiPaise: 59800 });
});

test('a prepaid original that covers the amount needs no manual transfer', () => {
  const split = refundSplitPaise(repl('missing_item'), { razorpay_payment_id: 'pay_x', amount_paise: 120000 });
  assert.deepEqual(split, { owedPaise: 59800, gatewayPaise: 59800, upiPaise: 0 });
});

test('partial COD refunds the deposit and leaves the rest to a transfer', () => {
  // 10% deposit captured online, the rest was cash to the courier.
  const split = refundSplitPaise(repl('missing_item'), { razorpay_payment_id: 'pay_x', amount_paise: 12000 });
  assert.deepEqual(split, { owedPaise: 59800, gatewayPaise: 12000, upiPaise: 47800 });
});

test('a missing original order is treated as unrefundable by gateway', () => {
  // Better to ask for a UPI id we may not need than to promise a refund route
  // that does not exist.
  const split = refundSplitPaise(repl('missing_item'), null);
  assert.equal(split.gatewayPaise, 0);
  assert.equal(split.upiPaise, 59800);
});
