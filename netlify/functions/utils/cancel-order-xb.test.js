const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { stopXpressbeesFirst, isXpressbees } = require('./xb-stop-first');

const order = { id: 'o1', tracking_id: '143449611651694', courier_name: 'XpressBees' };
const fake = (action, extra = {}) => ({ cancelCourierShipment: async () => ({ action, awb: order.tracking_id, ...extra }) });

test('XpressBees AWBs are recognised by courier name', () => {
  assert.equal(isXpressbees(order), true);
  assert.equal(isXpressbees({ courier_name: 'Xpressbees' }), true);
  assert.equal(isXpressbees({ courier_name: 'Delhivery' }), false);
  assert.equal(isXpressbees({}), false);
});

test('stopped or already cancelled at XpressBees -> the cancel may go ahead', async () => {
  assert.equal((await stopXpressbeesFirst(order, fake('cancelled'))).ok, true);
  assert.equal((await stopXpressbeesFirst(order, fake('already_cancelled'))).ok, true);
});

test('picked up meanwhile -> refused as moved', async () => {
  const r = await stopXpressbeesFirst(order, fake('moving', { state: 'in transit' }));
  assert.equal(r.ok, false);
  assert.equal(r.moved, true);
});

test('courier unreachable -> refused, not cancelled blind', async () => {
  const r = await stopXpressbeesFirst(order, fake('error', { message: 'timeout' }));
  assert.equal(r.ok, false);
  assert.equal(r.moved, false);
});

test('the XpressBees stop runs BEFORE the order is marked cancelled, and NimbusPost is not asked for it', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../cancel-order.js'), 'utf8');
  const stop = src.indexOf('xbStop = await stopXpressbeesFirst(order)');
  const flip = src.indexOf(".update({ status: 'cancelled' })");
  assert.ok(stop > 0 && flip > 0 && stop < flip, 'courier first, then the order');
  assert.match(src, /if \(xbStop && xbStop\.ok\) \{\s*\/\/ Stopped at XpressBees above/);
  assert.match(src, /cancellation_source: 'customer'/);
});

test('the WhatsApp bot stops XpressBees first too', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../whatsapp-bot.js'), 'utf8');
  const stop = src.indexOf('xbStop = await stopXpressbeesFirst(target)');
  const flip = src.indexOf("// Cancel + auto-refund (notifyOrderCancelled");
  assert.ok(stop > 0 && stop < flip);
  assert.match(src, /xbStop && xbStop\.ok\s*\? \{ ok: true, skipped: 'xpressbees' \}/);
});
