const test = require('node:test');
const assert = require('node:assert/strict');
const {
  replacementMeta,
  isMissingBookReplacement,
  missingValuePaise,
  refundSplitPaise,
  replacementCovers,
  itemTitleKey,
  reportedMissingTitles,
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


// ── Does the replacement on file actually carry the reported books? ──────────
// Only one replacement is allowed per order, so the one already there may have
// been raised for a different book entirely, or for an earlier report. Before
// telling a customer a parcel is coming, this has to be true.

const cart = (...titles) => ({ cart_items: titles.map(t => ({ title: t, price: 100, qty: 1 })) });

test('a replacement covers the books it actually contains', () => {
  assert.equal(replacementCovers(cart('Book A'), [{ title: 'Book A' }]), true);
  assert.equal(replacementCovers(cart('Book A', 'Book B'), [{ title: 'Book B' }]), true);
  assert.equal(replacementCovers(cart('Book A', 'Book B'), [{ title: 'Book A' }, { title: 'Book B' }]), true);
});

test('a second report naming a different book is NOT covered', () => {
  // The exact case that left books invisible: report Book A, get a replacement
  // for Book A, later report Book B. The guard finds a replacement and used to
  // report success, but nothing is shipping for Book B.
  assert.equal(replacementCovers(cart('Book A'), [{ title: 'Book B' }]), false);
  assert.equal(replacementCovers(cart('Book A'), [{ title: 'Book A' }, { title: 'Book B' }]), false);
});

test('a replacement raised for a damaged book does not cover a missing one', () => {
  assert.equal(replacementCovers(cart('Damaged Title'), [{ title: 'Missing Title' }]), false);
});

test('a replacement with no cart covers nothing', () => {
  assert.equal(replacementCovers({}, [{ title: 'Book A' }]), false);
  assert.equal(replacementCovers(null, [{ title: 'Book A' }]), false);
  assert.equal(replacementCovers({ cart_items: [] }, [{ title: 'Book A' }]), false);
});

test('titles match regardless of case and surrounding space', () => {
  assert.equal(replacementCovers(cart('  The Coworker  '), [{ title: 'the coworker' }]), true);
  assert.equal(itemTitleKey({ name: '  Play Bigger ' }), 'play bigger');
  assert.equal(itemTitleKey({}), '');
});

test('an untitled line can never be considered covered', () => {
  // Matching on an empty key would make every untitled line "already handled",
  // which is the failure this whole check exists to prevent.
  assert.equal(replacementCovers(cart('Book A'), [{ title: '' }]), false);
  assert.equal(replacementCovers(cart(''), [{ title: '' }]), false);
});


// ── The reason is a dropdown label; the `_missing` stamp is the customer ──────
// Raising a replacement for a reported-missing book under the wrong reason used
// to drop it out of this set entirely, so the refund owed for it went untracked.

/** An original order carrying the customer's own missing-book report. */
const reported = (...titles) => ({
  razorpay_order_id: 'IC-1',
  cart_items: titles.map(t => ({ title: t, price: 299, qty: 1, _missing: true, _missing_at: '2026-09-01T00:00:00Z' })),
});

test('a mislabelled replacement still counts when the customer reported the book missing', () => {
  const r = repl('damaged', [{ title: 'Book A', price: 299, qty: 1 }]);
  // The old one-argument behaviour: reason alone, so it does not qualify.
  assert.equal(isMissingBookReplacement(r), false);
  // With the original in hand, the customer's report decides.
  assert.equal(isMissingBookReplacement(r, reported('Book A')), true);
  assert.equal(isMissingBookReplacement(repl('wrong_item', [{ title: 'Book A' }]), reported('Book A')), true);
  assert.equal(isMissingBookReplacement(repl('other', [{ title: 'Book A' }]), reported('Book A')), true);
});

test('a genuine damaged-book replacement is still not a missing-book one', () => {
  // Nothing was reported missing on the original, so the reason set still rules.
  assert.equal(isMissingBookReplacement(repl('damaged', [{ title: 'Book A' }]), { cart_items: [{ title: 'Book A' }] }), false);
  assert.equal(isMissingBookReplacement(repl('missing_pages', [{ title: 'Book A' }]), { cart_items: [{ title: 'Book A' }] }), false);
});

test('a replacement for a DIFFERENT book than the one reported does not qualify', () => {
  // Book A never arrived; this parcel is a damaged Book B. Two separate issues,
  // and the refund owed for Book A must not be considered handled by it.
  assert.equal(isMissingBookReplacement(repl('damaged', [{ title: 'Book B' }]), reported('Book A')), false);
});

test('the two real reasons still qualify with no original at all', () => {
  assert.equal(isMissingBookReplacement(repl('missing_item'), null), true);
  assert.equal(isMissingBookReplacement(repl('incomplete_set'), undefined), true);
});

test('an order with no replacement metadata never qualifies, however it was reported', () => {
  assert.equal(isMissingBookReplacement({ cart_items: [{ title: 'Book A' }] }, reported('Book A')), false);
  assert.equal(isMissingBookReplacement(null, reported('Book A')), false);
});

test('reported titles are read only from real stamps', () => {
  assert.deepEqual([...reportedMissingTitles(reported('  Book A  '))], ['book a']);
  // A falsy or absent flag is not a report, and an untitled line is unusable.
  assert.equal(reportedMissingTitles({ cart_items: [{ title: 'A', _missing: false }] }).size, 0);
  assert.equal(reportedMissingTitles({ cart_items: [{ title: 'A' }] }).size, 0);
  assert.equal(reportedMissingTitles({ cart_items: [{ title: '', _missing: true }] }).size, 0);
  assert.equal(reportedMissingTitles(null).size, 0);
});

test('a truthy-but-not-true stamp is not a report', () => {
  // report-missing-books.js writes the boolean. Anything else is data we did
  // not write, and this panel moves money, so it is not trusted.
  assert.equal(reportedMissingTitles({ cart_items: [{ title: 'A', _missing: 'yes' }] }).size, 0);
  assert.equal(reportedMissingTitles({ cart_items: [{ title: 'A', _missing: 1 }] }).size, 0);
});
