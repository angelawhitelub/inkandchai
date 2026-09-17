'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isParamCountError, shippedEmailHtml } = require('./shipped-notification');

test('Metas parameter-count rejection is recognised by code', () => {
  // 132000 is what Meta returns when the template arity does not match, and
  // it is returned -- not thrown -- so nothing notices unless it is checked.
  assert.equal(isParamCountError({ data: { error: { code: 132000 } } }), true);
  assert.equal(isParamCountError({ data: { error: { code: '132000' } } }), true);
});

test('the rejection is also recognised by message, not only by code', () => {
  assert.equal(isParamCountError({ data: { error: { message: 'number of parameters does not match' } } }), true);
  assert.equal(isParamCountError({ data: { error: { error_data: { details: 'parameter count mismatch' } } } }), true);
});

test('an unrelated failure is NOT treated as a parameter-count problem', () => {
  // Retrying a different failure with fewer parameters would be noise, and
  // could deliver a wrongly-shaped message if the retry happened to pass.
  assert.equal(isParamCountError({ data: { error: { code: 131047, message: 'Re-engagement message' } } }), false);
  assert.equal(isParamCountError({ data: { error: { code: 190, message: 'Invalid token' } } }), false);
  assert.equal(isParamCountError({}), false);
  assert.equal(isParamCountError(null), false);
});

test('the shipped email carries the tracking link it was given', () => {
  const html = shippedEmailHtml({
    name: 'Nisha', orderNumber: 'IC-20260917-C6WPE', courier: 'Xpressbees',
    awb: '143449610518830',
    trackUrl: 'https://shipmentv2.xpressbees.com/orders/tracking/143449610518830',
    items: [{ title: 'Atomic Habits', qty: 1 }],
  });
  assert.ok(html.includes('shipmentv2.xpressbees.com/orders/tracking/143449610518830'));
  assert.ok(html.includes('143449610518830'));
  assert.ok(html.includes('Atomic Habits'));
  assert.ok(!/nimbuspost/i.test(html), 'no NimbusPost link may appear in a shipped email');
});

test('the email omits the track button when there is no link', () => {
  const html = shippedEmailHtml({ name: 'A', orderNumber: 'IC-1', courier: 'X', awb: '1', trackUrl: '', items: [] });
  assert.ok(!html.includes('Track your parcel'), 'a button with no URL must not be rendered');
});

/* ------------------------------------------------------------------ *
 * Send-order tests.
 *
 * The four-variable shape is not a guess: it was established over 49 real
 * sends on 2026-09-17, where every five-variable attempt returned Meta error
 * 132000 and every four-variable retry returned 200. Trying four FIRST is
 * what keeps the normal path from burning a rejected API call on every
 * shipment, so it is worth a test that fails if someone flips it back.
 * ------------------------------------------------------------------ */

function withStubs(waImpl) {
  const waPath = require.resolve('./whatsapp');
  const emailPath = require.resolve('./email');
  const notifyPath = require.resolve('./shipped-notification');
  const saved = { wa: require.cache[waPath], em: require.cache[emailPath], nf: require.cache[notifyPath] };
  const sent = [];
  require.cache[waPath] = {
    id: waPath, filename: waPath, loaded: true,
    exports: { sendWhatsApp: async (arg) => { sent.push(arg); return waImpl(arg, sent.length); } },
  };
  require.cache[emailPath] = {
    id: emailPath, filename: emailPath, loaded: true,
    exports: { sendEmail: async () => ({ ok: true }) },
  };
  delete require.cache[notifyPath];
  const mod = require('./shipped-notification');
  const restore = () => {
    if (saved.wa) require.cache[waPath] = saved.wa; else delete require.cache[waPath];
    if (saved.em) require.cache[emailPath] = saved.em; else delete require.cache[emailPath];
    if (saved.nf) require.cache[notifyPath] = saved.nf; else delete require.cache[notifyPath];
  };
  return { mod, sent, restore };
}

const ORDER = {
  razorpay_order_id: 'IC-TEST-0001',
  customer_name: 'Asha Menon',
  customer_phone: '919000000000',
  customer_email: 'asha@example.com',
  cart_items: [{ title: 'Gunahon Ka Devta', qty: 1 }],
};
const SHIP = { awb: '143449610518830', courier: 'Xpressbees', trackingUrl: 'https://shipmentv2.xpressbees.com/orders/tracking/143449610518830' };

test('the FOUR-variable shape is attempted first, and nothing follows it when accepted', async () => {
  const { mod, sent, restore } = withStubs(() => ({ ok: true, status: 200 }));
  try {
    const out = await mod.sendShippedNotification(ORDER, SHIP);
    assert.equal(sent.length, 1, 'an accepted send must not be retried');
    assert.equal(sent[0].params.length, 4, 'four variables must go first');
    assert.deepEqual(sent[0].params, ['Asha', 'Xpressbees', SHIP.awb, SHIP.trackingUrl]);
    assert.equal(out.whatsapp.ok, true);
  } finally { restore(); }
});

test('a parameter-count rejection falls back to FIVE, so a template edit cannot silence this', async () => {
  const { mod, sent, restore } = withStubs((arg) =>
    arg.params.length === 4
      ? { ok: false, status: 400, data: { error: { code: 132000, message: 'number of parameters does not match' } } }
      : { ok: true, status: 200 });
  try {
    const out = await mod.sendShippedNotification(ORDER, SHIP);
    assert.equal(sent.length, 2, 'the rejection must be retried');
    assert.equal(sent[1].params.length, 5);
    assert.equal(out.whatsapp.ok, true);
  } finally { restore(); }
});

test('an unrelated failure is NOT retried -- only a parameter-count error is', async () => {
  const { mod, sent, restore } = withStubs(() => ({ ok: false, status: 401, data: { error: { code: 190, message: 'expired token' } } }));
  try {
    const out = await mod.sendShippedNotification(ORDER, SHIP);
    assert.equal(sent.length, 1, 'a bad token must not trigger a second send');
    assert.equal(out.whatsapp.ok, false);
  } finally { restore(); }
});

test('a WhatsApp failure never throws, because the parcel has already shipped', async () => {
  const { mod, restore } = withStubs(() => { throw new Error('network down'); });
  try {
    const out = await mod.sendShippedNotification(ORDER, SHIP);
    assert.equal(out.whatsapp.ok, false);
    assert.equal(out.email.ok, true, 'email must still be attempted after WhatsApp dies');
  } finally { restore(); }
});

test('a customer with no phone is skipped rather than sent a blank message', async () => {
  const { mod, sent, restore } = withStubs(() => ({ ok: true, status: 200 }));
  try {
    const out = await mod.sendShippedNotification({ ...ORDER, customer_phone: null }, SHIP);
    assert.equal(sent.length, 0);
    assert.equal(out.whatsapp.skipped, true);
  } finally { restore(); }
});
