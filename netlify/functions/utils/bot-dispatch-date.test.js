'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatOrderContext } = require('../whatsapp-bot')._internal;

const order = { razorpay_order_id: 'IC-1', customer_name: 'A', amount_paise: 63900, created_at: '2026-11-11T14:42:00Z', status: 'cod_pending', cart_items: [{ title: 'Slow Book', qty: 1 }] };
const hold = { kind: 'handling', release: '2026-11-15', titles: ['Slow Book +3 days'] };

test('the bot sees the planned dispatch date of a held order', () => {
  const ctx = formatOrderContext(order, 'IC-1', hold);
  assert.match(ctx, /Dispatch date: handed to the courier on 15 November, because a book in it needs extra preparation time/);
  assert.match(ctx, /not a delay/);
});

test('no line once it has an AWB, or when nothing holds it', () => {
  assert.doesNotMatch(formatOrderContext({ ...order, tracking_id: '1434', status: 'shipped' }, 'IC-1', hold), /Dispatch date/);
  assert.doesNotMatch(formatOrderContext(order, 'IC-1', null), /Dispatch date/);
});

test('the bot sees clearance books that cannot be returned', () => {
  const o = { ...order, status: 'delivered', tracking_id: '1434', cart_items: [{ title: 'Cheap Book', qty: 1, _no_returns: true }, { title: 'Verity', qty: 1 }] };
  const ctx = formatOrderContext(o, 'IC-1', null);
  assert.match(ctx, /No returns \(stock clearance sale\): Cheap Book\./);
  assert.doesNotMatch(formatOrderContext(order, 'IC-1', null), /No returns/);
});
