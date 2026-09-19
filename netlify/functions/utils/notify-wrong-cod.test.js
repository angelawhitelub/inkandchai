'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildMessage, opening } = require('../admin-notify-wrong-cod').__test;

const paid = { order_id: 'IC-20260916-E4YN7', name: 'Ridhima Manni', book: 'Tomorrow, and Tomorrow, and Tomorrow', wrong_cod: 658, kind: 'PAID', awb: '1434516068' };
const repl = { order_id: 'IC-R-20260916-T3NUM', name: 'Sourav Patel', book: 'The Alchemist', wrong_cod: 599, kind: 'REPLACEMENT', awb: '1434516069' };

test('a customer who paid is told it is money they already paid', () => {
  const t = opening('PAID', 'The Alchemist', 599);
  assert.match(t, /paid for it in full/);
  assert.match(t, /already paid us once/);
});

test('a free replacement is never told it was a double payment', () => {
  const t = opening('REPLACEMENT', 'The Alchemist', 599);
  assert.match(t, /free replacement/);
  assert.match(t, /You owe nothing/);
  assert.doesNotMatch(t, /paid for it in full|already paid us once/,
    'telling someone we already failed that they paid for a free reship compounds the first mistake');
});

test('every message names the order, the book and the exact amount', () => {
  for (const r of [paid, repl]) {
    const { subject, html } = buildMessage(r);
    assert.ok(subject.includes(r.order_id), 'the subject must be identifiable before it is opened');
    assert.ok(html.includes(r.book));
    assert.ok(html.includes(String(r.wrong_cod)), 'a vague amount invites a wrong refund');
    assert.ok(html.includes(r.awb));
  }
});

test('the message asks for a UPI id and for nothing else', () => {
  const { html } = buildMessage(paid);
  assert.match(html, /UPI ID/);
  // A request for money-back details is shaped exactly like a fraud attempt.
  // The disclaimer is the only thing separating the two for the reader.
  assert.match(html, /never<\/strong> ask you for a card number, CVV, PIN, OTP, bank password/);
  assert.doesNotMatch(html, /account number|IFSC|CVV number required|password:/i);
});

test('an amount is grouped the Indian way and a missing name still greets', () => {
  const { html } = buildMessage({ ...paid, wrong_cod: 15529, name: '' });
  assert.match(html, /₹15,529/);
  assert.match(html, /Hi there,/);
});
