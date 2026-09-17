'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { toWooOrder, numericId, safeEqual, readCredentials, authorize, COD_TITLE, PREPAID_TITLE } =
  require('../woo-channel').__test;

const ADDR = 'Flat 12, Gokhale Rd, Dadar, Mumbai, Maharashtra - 400028';
const base = (over = {}) => ({
  id: 'uuid-1', razorpay_order_id: 'IC-20260916-TEST',
  customer_name: 'Test Buyer', customer_phone: '9876543210',
  customer_address: ADDR, customer_email: 't@example.com',
  created_at: '2026-09-16T18:58:56.000Z',
  cart_items: [{ title: 'Atomic Habits', sku: 'AH1', qty: 1, price: 499 }],
  ...over,
});

// ── The money mapping ──────────────────────────────────────────────────────
// XpressBees derives what the courier collects from `total` on a COD order.
// Every assertion about `total` below is an assertion about a customer's money.

test('prepaid order is not COD and declares its full value', async () => {
  const o = await toWooOrder(base({ amount_paise: 49900, status: 'paid', razorpay_payment_id: 'pay_x' }));
  assert.equal(o.payment_method, 'prepaid');
  assert.equal(o.payment_method_title, PREPAID_TITLE);
  assert.equal(o.total, '499.00');
  assert.equal(o.discount_total, '0.00');
});

test('pure COD collects the full amount', async () => {
  const o = await toWooOrder(base({ amount_paise: 49900, status: 'cod_pending' }));
  assert.equal(o.payment_method, 'cod');
  assert.equal(o.payment_method_title, COD_TITLE);
  assert.equal(o.total, '499.00');
});

test('partial COD totals the BALANCE, never the full order', async () => {
  // The whole reason this mapping is not a straight copy of orderValueRs.
  // A total of 517 here would charge the customer their 52 deposit twice.
  const o = await toWooOrder(base({
    amount_paise: 5200, status: 'partial_cod_pending',
    cart_items: [{ title: 'A', sku: 'A1', qty: 1, price: 517, _payment: { balance: 465, full_total: 517 } }],
  }));
  assert.equal(o.payment_method, 'cod');
  assert.equal(o.total, '465.00', 'collects the balance only');
  assert.equal(o.discount_total, '52.00', 'the advance is shown as already paid');
  const lineSum = o.line_items.reduce((t, l) => t + Number(l.total), 0);
  assert.equal(lineSum.toFixed(2), '517.00', 'line items still declare the whole order');
  assert.equal(Number(o.discount_total) + Number(o.total), lineSum, 'advance + collected = order value');
});

test('a partial-COD deposit is not mistaken for full prepayment', async () => {
  const o = await toWooOrder(base({
    amount_paise: 5200, status: 'partial_cod_pending', razorpay_payment_id: 'pay_deposit',
    cart_items: [{ title: 'A', sku: 'A1', qty: 1, price: 517, _payment: { balance: 465, full_total: 517 } }],
  }));
  assert.equal(o.payment_method, 'cod');
  assert.equal(o.total, '465.00');
});

test('replacement order never collects money', async () => {
  const o = await toWooOrder(base({
    razorpay_order_id: 'IC-R-20260916-TEST', status: 'replacement_pending', amount_paise: 0,
  }));
  assert.equal(o.payment_method, 'prepaid');
  assert.equal(o.total, '499.00', 'declared for customs, not collected');
});

test('an unpaid order wearing a non-COD status is still COD', async () => {
  const o = await toWooOrder(base({ amount_paise: 49900, status: 'confirmed' }));
  assert.equal(o.payment_method, 'cod', 'status is not evidence of payment');
});

test('collectable meta agrees with the total on every payment type', async () => {
  for (const over of [
    { amount_paise: 49900, status: 'paid', razorpay_payment_id: 'p' },
    { amount_paise: 49900, status: 'cod_pending' },
  ]) {
    const o = await toWooOrder(base(over));
    const collectable = o.meta_data.find((m) => m.key === '_iac_collectable').value;
    assert.equal(collectable, o.payment_method === 'cod' ? o.total : '0.00');
  }
});

// ── Shape XpressBees relies on ─────────────────────────────────────────────

test('order carries a 6-digit postcode and a 10-digit phone', async () => {
  const o = await toWooOrder(base({ amount_paise: 49900, status: 'cod_pending' }));
  assert.match(o.shipping.postcode, /^\d{6}$/);
  assert.match(o.shipping.phone, /^\d{10}$/);
  assert.equal(o.shipping.country, 'IN');
  assert.ok(o.shipping.address_1.length >= 10, 'address line must be shippable');
});

test('dates are WooCommerce shaped, with no timezone suffix', async () => {
  const o = await toWooOrder(base({ amount_paise: 49900, status: 'cod_pending' }));
  assert.match(o.date_created, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
});

test('order number survives as the human IC- reference', async () => {
  const o = await toWooOrder(base({ amount_paise: 49900, status: 'cod_pending' }));
  assert.equal(o.number, 'IC-20260916-TEST');
  assert.equal(typeof o.id, 'number', 'id must be an integer for Woo clients');
});

test('a stringified cart is parsed, not shipped as one line', async () => {
  const o = await toWooOrder(base({
    amount_paise: 99800, status: 'cod_pending',
    cart_items: JSON.stringify([
      { title: 'A', sku: 'A1', qty: 1, price: 499 },
      { title: 'B', sku: 'B1', qty: 1, price: 499 },
    ]),
  }));
  assert.equal(o.line_items.length, 2);
});

test('an order with no usable pincode is rejected, not shipped blind', async () => {
  await assert.rejects(
    () => toWooOrder(base({ amount_paise: 49900, status: 'cod_pending', customer_address: 'no pincode here' })),
    /pincode/i,
  );
});

test('an order with no usable phone is rejected', async () => {
  await assert.rejects(
    () => toWooOrder(base({ amount_paise: 49900, status: 'cod_pending', customer_phone: '123' })),
    /phone/i,
  );
});

// ── Authentication ─────────────────────────────────────────────────────────

test('numericId is stable, positive and fits a 32-bit int', () => {
  const a = numericId('IC-20260916-TEST');
  assert.equal(a, numericId('IC-20260916-TEST'));
  assert.ok(a > 0 && a <= 0x7fffffff);
  assert.notEqual(a, numericId('IC-20260916-OTHER'));
});

test('safeEqual rejects unequal lengths without throwing', () => {
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('', ''), true);
});

test('credentials are read from HTTP Basic', () => {
  const b64 = Buffer.from('ck_key:cs_secret').toString('base64');
  const got = readCredentials({ headers: { authorization: `Basic ${b64}` } });
  assert.deepEqual(got, { key: 'ck_key', secret: 'cs_secret' });
});

test('credentials are read from the query pair', () => {
  const got = readCredentials({ headers: {}, queryStringParameters: { consumer_key: 'ck', consumer_secret: 'cs' } });
  assert.deepEqual(got, { key: 'ck', secret: 'cs' });
});

test('a secret containing a colon survives Basic decoding', () => {
  const b64 = Buffer.from('ck_key:cs:with:colons').toString('base64');
  assert.equal(readCredentials({ headers: { authorization: `Basic ${b64}` } }).secret, 'cs:with:colons');
});

test('wrong secret is refused even when the key is right', () => {
  process.env.WOO_CONSUMER_KEY = 'ck_right';
  process.env.WOO_CONSUMER_SECRET = 'cs_right';
  const res = authorize({ headers: {}, queryStringParameters: { consumer_key: 'ck_right', consumer_secret: 'cs_wrong' } });
  assert.equal(res.ok, false);
  assert.equal(res.res.statusCode, 401);
});

test('correct credentials are accepted', () => {
  process.env.WOO_CONSUMER_KEY = 'ck_right';
  process.env.WOO_CONSUMER_SECRET = 'cs_right';
  assert.equal(authorize({ headers: {}, queryStringParameters: { consumer_key: 'ck_right', consumer_secret: 'cs_right' } }).ok, true);
});

test('an unconfigured store serves nothing rather than everything', () => {
  delete process.env.WOO_CONSUMER_KEY;
  delete process.env.WOO_CONSUMER_SECRET;
  const res = authorize({ headers: {}, queryStringParameters: {} });
  assert.equal(res.ok, false);
  assert.equal(res.res.statusCode, 503, 'missing config must never mean open access');
});

test('no credentials at all is refused', () => {
  process.env.WOO_CONSUMER_KEY = 'ck_right';
  process.env.WOO_CONSUMER_SECRET = 'cs_right';
  assert.equal(authorize({ headers: {}, queryStringParameters: {} }).ok, false);
});

test('a terse address is never served short -- it is rebuilt or refused', async () => {
  // enrichAddress fills city/state from a LIVE lookup (api.postalpincode.in,
  // 4s timeout), so asserting the rebuilt text makes this test depend on the
  // network. The invariant is what matters and holds either way: a short line
  // is either lengthened with the locality or the order is refused. It is
  // never handed to a courier as-is.
  let out = null;
  try { out = await toWooOrder(base({ amount_paise: 49900, status: 'cod_pending', customer_address: 'H 4, 400028' })); }
  catch (e) { assert.match(e.message, /too short/i); return; }
  assert.ok(out.shipping.address_1.length >= 10, `served "${out.shipping.address_1}"`);
});

test('an address that cannot reach 10 characters is refused', async () => {
  // Before sanitizeAddressText this did not throw: sanitizeForCourier('X')
  // returned the literal string 'Hindi Book', which is 10 characters, so a
  // one-character address silently passed the length floor and would have
  // been shipped to "Hindi Book".
  await assert.rejects(
    () => toWooOrder(base({ amount_paise: 49900, status: 'cod_pending', customer_address: 'X, 999999' })),
    /too short/i,
  );
});

test('a Devanagari customer name never becomes "Hindi Book"', async () => {
  const o = await toWooOrder(base({ amount_paise: 49900, status: 'cod_pending', customer_name: '\u0930\u093e\u0939\u0941\u0932 \u0936\u0930\u094d\u092e\u093e' }));
  const full = `${o.shipping.first_name} ${o.shipping.last_name}`.trim();
  assert.ok(!/Hindi Book/.test(full), 'the book-title fallback must never name a person');
  assert.equal(full, 'Customer', 'an unrenderable name falls back to Customer');
});

test('an address is never replaced by the book-title fallback', async () => {
  const o = await toWooOrder(base({ amount_paise: 49900, status: 'cod_pending' }));
  assert.ok(!/Hindi Book/.test(o.shipping.address_1));
});

test('a PhonePe-pending order is never in the feed', () => {
  const { isPaymentPending } = require('../woo-channel').__test;
  assert.equal(isPaymentPending('pending_phonepe'), true);
  assert.equal(isPaymentPending('pending'), true);
  // These are pending COLLECTION, not pending payment, and must still ship.
  assert.equal(isPaymentPending('cod_pending'), false);
  assert.equal(isPaymentPending('partial_cod_pending'), false);
  assert.equal(isPaymentPending('paid'), false);
});

test('the feed defaults to a page big enough for a full sync', () => {
  // The first live sync pulled exactly 100 of 157 orders and never asked for
  // page 2, so a 20-order default and a 100-order cap both silently truncate.
  const src = require('node:fs').readFileSync(require.resolve('../woo-channel'), 'utf8');
  assert.match(src, /parseInt\(q\.per_page \|\| '100'/, 'default page must not be 20');
  assert.match(src, /Math\.min\(250,/, 'cap must exceed one window of orders');
  assert.match(src, /ascending: true/, 'oldest orders must win the single page');
});

test('a status push-back never mutates order state', () => {
  // The guarantee is structural, so assert on the source: this handler must
  // not reach Supabase at all. An RTO arriving here must be incapable of
  // touching anything a refund could key off.
  const src = require('node:fs').readFileSync(require.resolve('../woo-channel'), 'utf8');
  const block = src.slice(src.indexOf('if (method !== \'GET\')'), src.indexOf('const supabase = createClient'));
  assert.ok(block.length > 0, 'push-back block not found');
  for (const forbidden of ['supabase', '.update(', 'refund', 'razorpay', 'phonepe']) {
    assert.ok(!block.toLowerCase().includes(forbidden.toLowerCase()),
      `push-back handler must not reference ${forbidden}`);
  }
});
