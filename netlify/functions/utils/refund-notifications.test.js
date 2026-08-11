/**
 * Tests for partial-refund notification content.
 *
 * Origin: a ₹239 partial on IC-20260807-7A127 (₹592, three books) told the
 * customer only that ₹239 had been refunded — with no way to tell which of
 * James / Taiwan Travelogue / Hitchhiker's Guide it was for, and wording that
 * implied the whole order was being unwound.
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  cleanRefundItems, refundItemsLine, refundPartialEmailHtml, refundInitiatedEmailHtml,
} = require('./refund-notifications');

const ORDER = {
  razorpay_order_id: 'IC-20260807-7A127',
  customer_name: 'Pranati Panda',
  amount_paise: 59200,
};
const ITEMS = [
  { title: 'James: Winner of the 2025 Pulitzer Prize', qty: 1, amount: 239 },
  { title: 'Taiwan Travelogue', qty: 2, amount: 249 },
];

test('items are normalised, capped and stripped of junk', () => {
  const out = cleanRefundItems([
    { title: '  The   Hitchhiker\'s  Guide ', qty: '3', amount: '169.4' },
    { title: '', qty: 1, amount: 10 },            // no title → dropped
    { title: 'x'.repeat(300), qty: -5, amount: -9 },
  ]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].title, "The Hitchhiker's Guide", 'whitespace collapsed');
  assert.strictEqual(out[0].qty, 3);
  assert.strictEqual(out[0].amount, 169);
  assert.strictEqual(out[1].title.length, 120, 'title capped');
  assert.strictEqual(out[1].qty, 1, 'qty floored at 1');
  assert.strictEqual(out[1].amount, 0, 'negative amount floored at 0');
});

test('non-arrays and rubbish yield an empty list, never a throw', () => {
  for (const v of [null, undefined, 'books', 42, {}]) {
    assert.deepStrictEqual(cleanRefundItems(v), []);
  }
});

test('the WhatsApp line names the books, with quantities only when >1', () => {
  assert.strictEqual(
    refundItemsLine(ITEMS),
    'James: Winner of the 2025 Pulitzer Prize, Taiwan Travelogue ×2');
  assert.strictEqual(refundItemsLine([]), '');
});

test('the partial email names each book and its amount', () => {
  const html = refundPartialEmailHtml(ORDER, 23900, 'rfnd_test', ITEMS);
  assert.ok(html.includes('James: Winner of the 2025 Pulitzer Prize'), 'book title present');
  assert.ok(html.includes('Taiwan Travelogue'), 'second book present');
  assert.ok(html.includes('₹239'), 'per-book amount present');
  assert.ok(html.includes('Pranati'), 'greets by first name');
  assert.ok(html.includes('rfnd_test'), 'refund reference present');
});

test('the partial email states the remaining balance is unaffected', () => {
  const html = refundPartialEmailHtml(ORDER, 23900, null, ITEMS);
  assert.ok(/partial/i.test(html));
  assert.ok(html.includes('₹353'), 'the ₹592 − ₹239 remainder is spelled out');
  assert.ok(/unaffected/i.test(html));
});

test('a partial with no ticked items still renders, minus the breakdown', () => {
  const html = refundPartialEmailHtml(ORDER, 23900, null, []);
  assert.ok(html.includes('₹239'));
  assert.ok(!/What this refund covers/.test(html), 'no empty items table');
});

test('the full-refund email is untouched — no partial wording leaks in', () => {
  const html = refundInitiatedEmailHtml(ORDER, 59200, null);
  assert.ok(!/partial/i.test(html));
  assert.ok(!/unaffected/i.test(html));
});

test('an over-long list is capped so the email cannot be flooded', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ title: `Book ${i}`, qty: 1, amount: 10 }));
  assert.strictEqual(cleanRefundItems(many).length, 12);
});
