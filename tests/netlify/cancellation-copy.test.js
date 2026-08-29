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

test('the customer path still uses the existing approved template', () => {
  // order_cancelled keeps its name, its send history and its quality rating —
  // only its body is edited. The out-of-stock message is a separate template.
  assert.match(notifier, /process\.env\.WHATSAPP_ORDER_CANCELLED_TEMPLATE \|\| 'order_cancelled'/);
});

test('every WhatsApp body parameter is whitespace-flattened before sending', () => {
  assert.match(whatsapp, /params\.map\(p => \(\{ type: 'text', text: String\(p\)\.replace\(\/\\s\+\/g, ' '\)\.trim\(\) \}\)\)/);
});

const { cancellationKind, cancellationCopy } = require('../../netlify/functions/utils/order-cancelled-notification');

test('the cancellation kind is derived, and defaults to our side', () => {
  assert.equal(cancellationKind({ kind: 'customer' }), 'customer');
  assert.equal(cancellationKind({ kind: 'store' }), 'store');
  assert.equal(cancellationKind({ paymentFailed: true }), 'payment_failed');
  // paymentFailed wins even if a caller also passed a kind
  assert.equal(cancellationKind({ kind: 'customer', paymentFailed: true }), 'payment_failed');
  // unknown or absent -> store, the safe default for an unattributed cancellation
  assert.equal(cancellationKind({}), 'store');
  assert.equal(cancellationKind({ kind: 'nonsense' }), 'store');
  assert.equal(cancellationKind(), 'store');
});

test('a customer-requested cancellation is never blamed on stock', () => {
  const c = cancellationCopy('customer', 'Asha');
  assert.match(c.body, /as you requested/i);
  assert.doesNotMatch(c.body, /stock/i);
  assert.doesNotMatch(c.body, /supplier|publisher/i);
});

test('a failed payment is not blamed on stock either', () => {
  const c = cancellationCopy('payment_failed', 'Asha');
  assert.match(c.body, /payment did not complete/i);
  assert.doesNotMatch(c.body, /stock|supplier|publisher/i);
});

test('our own cancellation carries the out-of-stock explanation', () => {
  const c = cancellationCopy('store', 'Asha');
  assert.match(c.body, /supplier\/publisher had no stock/);
  assert.match(c.cta, /Order again/);
});

test('every kind addresses the customer by first name and offers a way back', () => {
  for (const k of ['customer', 'store', 'payment_failed']) {
    const c = cancellationCopy(k, 'Asha');
    assert.match(c.body, /Hi Asha,/);
    assert.ok(c.heading && c.cta && c.tail, `${k} is missing a field`);
  }
});

test('the two WhatsApp templates are separately gated', () => {
  // The stock template is new (opt in by name); order_cancelled is being edited
  // from 2 variables to 4 (opt in by the V2 flag). Neither can break sends
  // before its own flag is set.
  assert.match(notifier, /WHATSAPP_ORDER_CANCELLED_STOCK_TEMPLATE/);
  assert.match(notifier, /const useStock = kind === 'store' && !!stockTemplate;/);
  assert.match(notifier, /params: \(useStock \|\| v2\)/);
});

test('the subject line matches the body it introduces', () => {
  // An inbox preview reading "out of stock" above a mail saying "as you
  // requested" is worse than no subject at all.
  const subjectFor = new Function('return ' + notifier.match(/function subjectFor[\s\S]*?\n}\n/)[0])();
  assert.match(subjectFor('customer', 'IC-1'), /cancelled as requested/);
  assert.doesNotMatch(subjectFor('customer', 'IC-1'), /stock/i);
  assert.match(subjectFor('payment_failed', 'IC-1'), /Payment didn't go through/);
  assert.doesNotMatch(subjectFor('payment_failed', 'IC-1'), /stock/i);
  assert.match(subjectFor('store', 'IC-1'), /out of stock/);
});

test('customer and bot cancellations are tagged at the call sites', () => {
  // Without this tag they fall through to the default and get told the
  // supplier ran out of stock for an order they cancelled themselves.
  for (const f of ['cancel-order.js', 'whatsapp-bot.js']) {
    const src = fs.readFileSync(path.resolve(__dirname, '../../netlify/functions/' + f), 'utf8');
    const calls = (src.match(/notifyOrderCancelled\(/g) || []).length;
    const tagged = (src.match(/kind: 'customer'/g) || []).length;
    assert.equal(tagged, calls, `${f}: ${calls} cancellation call(s) but ${tagged} tagged as customer-initiated`);
  }
});
