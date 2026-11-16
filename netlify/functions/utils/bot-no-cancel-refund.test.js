'use strict';
// Owner rule, 16 Nov 2026: the WhatsApp bot never cancels an order or refunds.
const test = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../whatsapp-bot')._internal;
const MONEY = ['cancel_order', 'refund_wrong_cod', 'record_wrong_cod_upi'];

function withFlag(value, fn) {
  const before = process.env.WHATSAPP_BOT_CANCEL_REFUND;
  if (value === undefined) delete process.env.WHATSAPP_BOT_CANCEL_REFUND;
  else process.env.WHATSAPP_BOT_CANCEL_REFUND = value;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.WHATSAPP_BOT_CANCEL_REFUND;
    else process.env.WHATSAPP_BOT_CANCEL_REFUND = before;
  }
}

test('the model is never offered a cancel or refund tool', () => withFlag(undefined, () => {
  const names = bot.botTools().map((t) => t.function.name);
  for (const n of MONEY) assert.ok(!names.includes(n), n);
  assert.ok(names.includes('submit_order_request'));
  assert.ok(names.includes('report_missing_book'));
}));

test('a cancel or refund call is refused before touching any order', async () => {
  const before = process.env.WHATSAPP_BOT_CANCEL_REFUND;
  delete process.env.WHATSAPP_BOT_CANCEL_REFUND;
  try {
    // No Supabase is configured here: reaching the database would throw.
    for (const r of [
      await bot.cancelOrderViaBot('919876543210', { order_id: 'IC-20261116-AAAAA' }),
      await bot.refundWrongCodViaBot('919876543210', {}),
      await bot.recordWrongCodUpi('919876543210', { upi_id: '9876543210@ybl' }),
    ]) {
      assert.equal(r.ok, false);
      assert.equal(r.error, 'not-available-on-whatsapp');
      assert.match(r.message, /\[ESCALATE\]/);
    }
  } finally {
    if (before !== undefined) process.env.WHATSAPP_BOT_CANCEL_REFUND = before;
  }
});

test('the prompt tells the bot to hand cancels and refunds to the team, last', () => withFlag(undefined, () => {
  const s = bot.buildSystemContent('Store rule: cancel within 30 minutes.', null, 'Cancellable now: YES');
  const i = s.indexOf('CANCELLATIONS AND REFUNDS ARE NOT DONE ON WHATSAPP');
  assert.ok(i > s.indexOf('ORDER CONTEXT FOR THIS CONVERSATION'));
  assert.match(s.slice(i), /\[ESCALATE\]/);
}));

test('order context no longer advertises a cancel', () => withFlag(undefined, () => {
  const order = {
    razorpay_order_id: 'IC-20261110-BBBBB', customer_name: 'A', amount_paise: 49900, status: 'shipped',
    created_at: new Date(Date.now() - 3 * 864e5).toISOString(), tracking_id: '1434000000001', cart_items: [],
  };
  assert.doesNotMatch(bot.formatOrderContext(order), /Cancellable now/);
}));

test('WHATSAPP_BOT_CANCEL_REFUND=1 brings the tools back', () => withFlag('1', () => {
  const names = bot.botTools().map((t) => t.function.name);
  for (const n of MONEY) assert.ok(names.includes(n), n);
  assert.doesNotMatch(bot.buildSystemContent('', null, ''), /NOT DONE ON WHATSAPP/);
}));
