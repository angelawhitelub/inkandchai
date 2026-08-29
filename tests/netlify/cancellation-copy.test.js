const test = require('node:test');
const assert = require('node:assert/strict');
const { refundSentence, refundSentenceShort } = require('../../netlify/functions/utils/order-cancelled-notification');

const prepaid = { amount_paise: 35900, razorpay_payment_id: 'pay_ABC123' };
const phonepe = { amount_paise: 35900, razorpay_payment_id: 'OM2608281705' };
const cod     = { amount_paise: 35900, razorpay_payment_id: null };
const zero    = { amount_paise: 0, razorpay_payment_id: 'pay_ABC123' };

test('a COD customer is never told a refund is coming', () => {
  for (const fn of [refundSentence, refundSentenceShort]) {
    const s = fn(cod, { ok: true, nextStatus: 'refunded' });   // even if a refund object is somehow passed
    assert.match(s, /not charged/i);
    assert.doesNotMatch(s, /refund (has been|is being) (issued|processed)/i);
  }
});

test('an order that captured nothing is treated as unpaid', () => {
  assert.match(refundSentence(zero, { ok: true, nextStatus: 'refunded' }), /not charged/i);
});

test('a confirmed refund is stated plainly, with the amount and a timeline', () => {
  const s = refundSentence(prepaid, { ok: true, nextStatus: 'refunded' });
  assert.match(s, /has been issued/);
  assert.match(s, /Rs\. 359/);
  assert.match(s, /3-7 working days/);
});

test('an unconfirmed refund is promised, never claimed as already issued', () => {
  // Gateway error, still pending, RTO, or already in flight — all reach here.
  // { ok: true, nextStatus: 'refund_pending' } is the PhonePe case: the gateway
  // accepted the refund but has not settled it. That is NOT "issued" yet.
  for (const refund of [{ ok: false }, null, undefined, { skipped: 'already-refunded' },
                        { skipped: 'rto-no-auto-refund' }, { ok: true, nextStatus: 'refund_pending' }]) {
    const s = refundSentence(phonepe, refund);
    assert.match(s, /is being processed/);
    assert.doesNotMatch(s, /has been issued/);
  }
});

test('skipRefund (payment never captured) says nothing was charged', () => {
  assert.match(refundSentence(prepaid, null, { skipRefund: true }), /not charged/i);
  assert.match(refundSentenceShort(prepaid, null, { skipRefund: true }), /not charged/i);
});

test('both gateways get the same wording — the customer does not care which', () => {
  assert.equal(refundSentence(prepaid, { ok: true, nextStatus: 'refunded' }), refundSentence(phonepe, { ok: true, nextStatus: 'refunded' }));
});

const { bookListShort } = require('../../netlify/functions/utils/order-cancelled-notification');

const order = (items, extra = {}) => ({ amount_paise: 35900, razorpay_payment_id: 'OM1', cart_items: items, ...extra });

test('the WhatsApp book list names the books, with quantities', () => {
  assert.equal(bookListShort(order([{ title: 'The Essential Rumi', qty: 1 }])), 'The Essential Rumi');
  assert.equal(bookListShort(order([{ title: 'Atomic Habits', qty: 2 }])), 'Atomic Habits x2');
  assert.equal(
    bookListShort(order([{ title: 'Kaizen', qty: 1 }, { title: 'Wabi Sabi', qty: 3 }])),
    'Kaizen, Wabi Sabi x3'
  );
});

test('the book list is safe to put in a WhatsApp parameter', () => {
  // Meta rejects the send outright on a newline, a tab, or 4+ spaces.
  const nasty = bookListShort(order([{ title: 'A Title\nWith\tBreaks    and   spaces', qty: 1 }]));
  assert.doesNotMatch(nasty, /[\n\t]/);
  assert.doesNotMatch(nasty, / {4}/);
  assert.equal(nasty, 'A Title With Breaks and spaces');
});

test('a long cart is truncated on a title boundary, never mid-word', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ title: `Some Reasonably Long Book Title Number ${i}`, qty: 1 }));
  const out = bookListShort(order(many));
  assert.ok(out.length <= 260, `too long for a body param: ${out.length}`);
  assert.match(out, /\+\d+ more$/);
  // every kept entry is a whole title
  for (const part of out.replace(/ \+\d+ more$/, '').split(', ')) {
    assert.ok(many.some(m => m.title === part), `truncated mid-title: "${part}"`);
  }
});

test('a single over-long title still fits', () => {
  const out = bookListShort(order([{ title: 'x'.repeat(500), qty: 1 }]));
  assert.ok(out.length <= 220, out.length);
});

test('an empty cart degrades to something readable', () => {
  assert.equal(bookListShort(order([])), 'your order');
  assert.equal(bookListShort(order([{ title: '', qty: 1 }])), 'your order');
});

test('the WhatsApp refund line carries the amount', () => {
  assert.match(refundSentenceShort(order([]), { ok: true, nextStatus: 'refunded' }), /Rs\. 359/);
  assert.match(refundSentenceShort(order([]), { ok: false }), /Rs\. 359/);
  // ...but a COD customer still sees no amount and no refund promise
  const cod = refundSentenceShort(order([], { razorpay_payment_id: null }), null);
  assert.match(cod, /not charged/i);
  assert.doesNotMatch(cod, /Rs\./);
});

const fs = require('fs');
const path = require('path');
const notifier = fs.readFileSync(
  path.resolve(__dirname, '../../netlify/functions/utils/order-cancelled-notification.js'), 'utf8');
const whatsapp = fs.readFileSync(
  path.resolve(__dirname, '../../netlify/functions/utils/whatsapp.js'), 'utf8');

test('the WhatsApp parameter count is env-gated, not hard-switched on deploy', () => {
  // Meta rejects a send whose parameter count differs from the approved body,
  // so the 2 -> 4 variable change must be flippable independently of the deploy.
  assert.match(notifier, /WHATSAPP_ORDER_CANCELLED_V2/);
  assert.match(notifier, /\[firstName, id\]/);                       // legacy 2-variable body
  assert.match(notifier, /bookListShort\(order\), refundSentenceShort/); // v2 4-variable body
});

test('it still edits the existing template rather than needing a new name', () => {
  assert.match(notifier, /process\.env\.WHATSAPP_ORDER_CANCELLED_TEMPLATE \|\| 'order_cancelled'/);
  assert.doesNotMatch(notifier, /WHATSAPP_ORDER_CANCELLED_STOCK_TEMPLATE/);
});

test('every WhatsApp body parameter is whitespace-flattened before sending', () => {
  assert.match(whatsapp, /params\.map\(p => \(\{ type: 'text', text: String\(p\)\.replace\(\/\\s\+\/g, ' '\)\.trim\(\) \}\)\)/);
});
