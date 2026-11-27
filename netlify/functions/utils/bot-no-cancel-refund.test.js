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

test('the model is offered only the 7-day cancel, never a refund tool', () => withFlag(undefined, () => {
  const names = bot.botTools().map((t) => t.function.name);
  assert.ok(names.includes('cancel_order'));
  for (const n of ['refund_wrong_cod', 'record_wrong_cod_upi']) assert.ok(!names.includes(n), n);
  assert.ok(names.includes('submit_order_request'));
  assert.ok(names.includes('report_missing_book'));
}));

test('a refund call is refused before touching any order', async () => withFlag(undefined, async () => {
  // No Supabase is configured here: reaching the database would throw.
  for (const r of [
    await bot.refundWrongCodViaBot('919876543210', {}),
    await bot.recordWrongCodUpi('919876543210', { upi_id: '9876543210@ybl' }),
  ]) {
    assert.equal(r.ok, false);
    assert.equal(r.error, 'not-available-on-whatsapp');
    assert.match(r.message, /\[ESCALATE\]/);
  }
}));

// Owner, 28 Nov 2026: not picked up 7+ days after ordering = the bot may cancel.
const DAY = 864e5;
const unpicked = (over = {}) => ({
  id: 'u1', razorpay_order_id: 'IC-20261120-CCCCC', customer_name: 'A', amount_paise: 59900, status: 'shipped',
  razorpay_payment_id: 'pay_x', created_at: new Date(Date.now() - 8 * DAY).toISOString(),
  tracking_id: '1434000000002', courier_name: 'XpressBees', cart_items: [], ...over,
});

test('7+ days not picked up: the bot cancels through the My Orders path, full refund', async () => withFlag(undefined, async () => {
  let called = null;
  const fake = async (db, order, deps) => { called = { order, deps }; return { status: 200, body: { success: true, outcome: 'cancelled', message: 'Order cancelled. Your full refund of ₹599 has been started.' } }; };
  const r = await bot.unpicked7ViaBot({}, unpicked(), { cancelUnpickedOrder: fake });
  assert.equal(r.ok, true);
  assert.equal(r.was_prepaid, true);
  assert.equal(called.deps.anyPayment, true);
  assert.match(r.message, /₹599/);
}));

test('7+ days not picked up, Cash on Delivery: cancelled, nothing to refund', async () => withFlag(undefined, async () => {
  for (const o of [unpicked({ razorpay_payment_id: null }), unpicked({ razorpay_payment_id: null, status: 'cod_pending', tracking_id: null })]) {
    const q = bot.unpicked7Quote(o);
    assert.ok(q, o.status);
    assert.equal(q.refundPaise, 0);
  }
}));

test('under 7 days: no cancel, the date is given and the team takes over', async () => withFlag(undefined, async () => {
  let called = false;
  const r = await bot.unpicked7ViaBot({}, unpicked({ created_at: new Date(Date.now() - 3 * DAY).toISOString() }), { cancelUnpickedOrder: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'too-soon');
  assert.match(r.message, /\[ESCALATE\]/);
}));

test('picked up or delivered: no cancel on WhatsApp', async () => withFlag(undefined, async () => {
  let called = false;
  const fake = async () => { called = true; };
  for (const o of [unpicked({ shipment_moved_at: new Date(Date.now() - 5 * DAY).toISOString() }), unpicked({ status: 'delivered' })]) {
    const r = await bot.unpicked7ViaBot({}, o, { cancelUnpickedOrder: fake });
    assert.equal(r.error, 'not-available-on-whatsapp');
  }
  assert.equal(called, false);
}));

test('order context marks a 7-day unpicked order as cancellable on WhatsApp', () => withFlag(undefined, () => {
  assert.match(bot.formatOrderContext(unpicked()), /NOT PICKED UP FOR 7\+ DAYS — cancellable on WhatsApp: YES.*₹599/);
  assert.doesNotMatch(bot.formatOrderContext(unpicked({ created_at: new Date(Date.now() - 2 * DAY).toISOString() })), /7\+ DAYS/);
}));

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
