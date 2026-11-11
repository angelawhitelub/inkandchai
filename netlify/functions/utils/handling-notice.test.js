'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handlingNotice, handlingNoticeHtml, handlingNoticeText } = require('./handling-notice');

const PLACED = Date.parse('2026-11-11T14:42:00Z'); // 11 Nov, 20:12 IST

test('a book with handling days: the customer is told the handover date', () => {
  const cart = [{ title: 'Slow Book', qty: 1, _handling_days: 3 }, { title: 'Verity', qty: 1 }];
  const n = handlingNotice(cart, PLACED);
  assert.equal(n.iso, '2026-11-15');
  assert.equal(n.label, '15 Nov');
  assert.deepEqual(n.titles, ['Slow Book']);
  assert.match(handlingNoticeHtml(cart, PLACED), /Slow Book.*handed to the courier on <strong>15 Nov<\/strong>/s);
  assert.equal(handlingNoticeText(cart, PLACED), '(ships together on 15 Nov: extra preparation time)');
  assert.doesNotMatch(handlingNoticeText(cart, PLACED), /\n/);
});

test('no handling days: nothing is added', () => {
  const cart = [{ title: 'Verity', qty: 1 }, { _payment: { balance: 10 } }];
  assert.equal(handlingNotice(cart, PLACED), null);
  assert.equal(handlingNoticeHtml(cart, PLACED), '');
  assert.equal(handlingNoticeText(cart, PLACED), '');
});

test('the WhatsApp confirmation carries the date on the book-list line', async () => {
  const { sendOrderConfirmed } = require('./order-cover');
  const sent = [];
  const send = async (m) => { sent.push(m); return { ok: true }; };
  await sendOrderConfirmed({ to: '9', placedAt: PLACED, cart: [{ title: 'Slow Book', _handling_days: 3 }], params: ['A', 'IC-1', '₹1', 'addr', 'Slow Book'] }, { sendWhatsApp: send });
  assert.equal(sent[0].params[4], 'Slow Book (ships together on 15 Nov: extra preparation time)');
  await sendOrderConfirmed({ to: '9', cart: [{ title: 'Verity' }], params: ['A', 'IC-1', '₹1', 'addr', 'Verity'] }, { sendWhatsApp: send });
  assert.equal(sent[1].params[4], 'Verity');
});
