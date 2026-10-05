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

// ── Status push-back ───────────────────────────────────────────────────────
// Payload shape below is the one captured live when orders were booked, not
// a guess: {status:"On Hold", meta_data:[{key:"AWB Number",value:"..."}, ...]}

const { applyPushBack, metaValue } = require('../woo-channel').__test;

const ORDER_NO = 'IC-20260917-C6WPE';
const WOO_ID = numericId(ORDER_NO);

// A paging fake: `rows` is the whole lookup window, newest first, served in
// .range() slices the way PostgREST does; .eq().maybeSingle() fetches one.
function stubDb(rowOrRows, captured, reads = []) {
  const rows = Array.isArray(rowOrRows) ? rowOrRows : (rowOrRows ? [rowOrRows] : []);
  let byId = null;
  return {
    from() { byId = null; return this; },
    select() { return this; },
    gte() { return this; },
    order() { return this; },
    range(a, b) { reads.push([a, b]); return Promise.resolve({ data: rows.slice(a, b + 1), error: null }); },
    eq(col, v) { byId = v; return this; },
    maybeSingle() { return Promise.resolve({ data: rows.find(r => r.id === byId) || null, error: null }); },
    update(payload) { captured.push(payload); return { eq: () => Promise.resolve({ error: null }) }; },
  };
}
const pushed = (status, awb) => ({
  status,
  meta_data: [
    { key: 'Tracking Url', value: `https://shipmentv1.xpressbees.com/orders/tracking/${awb}` },
    { key: 'Courier Name', value: 'Xpressbees' },
    { key: 'AWB Number', value: awb },
  ],
});

test('a booked push flips the order to shipped and stores the AWB', async () => {
  const captured = [];
  const db = stubDb({ id: 'uuid-1', razorpay_order_id: ORDER_NO, status: 'cod_pending' }, captured);
  const res = await applyPushBack(db, WOO_ID, pushed('On Hold', '143449610504655'));
  assert.equal(res.applied, true, res.reason);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].status, 'shipped');
  assert.equal(captured[0].tracking_id, '143449610504655');
  assert.equal(captured[0].courier_name, 'Xpressbees');
  assert.ok(captured[0].shipped_at);
});

test('the stored tracking URL is normalised to shipmentv2', async () => {
  // They push shipment. and shipmentv1. on different orders; both redirect to
  // v2. One canonical host is stored rather than whichever they happened to send.
  const captured = [];
  const db = stubDb({ id: 'u', razorpay_order_id: ORDER_NO, status: 'paid' }, captured);
  await applyPushBack(db, WOO_ID, pushed('On Hold', '143449610504655'));
  assert.equal(captured[0].tracking_url,
    'https://shipmentv2.xpressbees.com/orders/tracking/143449610504655');
});

test('RTO changes nothing at all', async () => {
  // A returned parcel is not a refunded order.
  const captured = [];
  const db = stubDb({ id: 'u', razorpay_order_id: ORDER_NO, status: 'shipped' }, captured);
  const res = await applyPushBack(db, WOO_ID, pushed('Cancelled', '143449610504655'));
  assert.equal(res.applied, false);
  assert.equal(captured.length, 0, 'RTO must not write to the order');
});

test('In Transit and Delivered are recorded but change nothing', async () => {
  for (const st of ['Processing', 'Completed']) {
    const captured = [];
    const db = stubDb({ id: 'u', razorpay_order_id: ORDER_NO, status: 'shipped' }, captured);
    const res = await applyPushBack(db, WOO_ID, pushed(st, '1434496105'));
    assert.equal(res.applied, false, `${st} must not be applied`);
    assert.equal(captured.length, 0);
  }
});

test('a booked push with no AWB is refused rather than half-applied', async () => {
  const captured = [];
  const db = stubDb({ id: 'u', razorpay_order_id: ORDER_NO, status: 'paid' }, captured);
  const res = await applyPushBack(db, WOO_ID, { status: 'On Hold', meta_data: [] });
  assert.equal(res.applied, false);
  assert.match(res.reason, /no AWB/i);
  assert.equal(captured.length, 0);
});

test('a delivered order is never walked back to shipped', async () => {
  const captured = [];
  const db = stubDb({ id: 'u', razorpay_order_id: ORDER_NO, status: 'delivered' }, captured);
  const res = await applyPushBack(db, WOO_ID, pushed('On Hold', '999'));
  assert.equal(res.applied, false);
  assert.equal(captured.length, 0);
});

test('a re-push of the same AWB is a no-op', async () => {
  const captured = [];
  const db = stubDb({ id: 'u', razorpay_order_id: ORDER_NO, status: 'shipped', tracking_id: '143449610504655' }, captured);
  const res = await applyPushBack(db, WOO_ID, pushed('On Hold', '143449610504655'));
  assert.equal(res.applied, false);
  assert.equal(captured.length, 0);
});

test('an unmatched woo id is reported, never applied to some other order', async () => {
  const captured = [];
  const db = stubDb({ id: 'u', razorpay_order_id: 'IC-SOMETHING-ELSE', status: 'paid' }, captured);
  const res = await applyPushBack(db, WOO_ID, pushed('On Hold', '123'));
  assert.equal(res.applied, false);
  assert.equal(captured.length, 0);
});

test('a push never writes a refund field', async () => {
  const captured = [];
  const db = stubDb({ id: 'u', razorpay_order_id: ORDER_NO, status: 'paid' }, captured);
  await applyPushBack(db, WOO_ID, pushed('On Hold', '123'));
  const keys = Object.keys(captured[0]).join(',').toLowerCase();
  for (const forbidden of ['refund', 'razorpay', 'phonepe', 'amount']) {
    assert.ok(!keys.includes(forbidden), `push wrote ${forbidden}: ${keys}`);
  }
});

test('meta_data keys are read case-insensitively', () => {
  assert.equal(metaValue({ meta_data: [{ key: 'awb number', value: 'X1' }] }, 'AWB Number'), 'X1');
  assert.equal(metaValue({ meta_data: [] }, 'AWB Number'), '');
  assert.equal(metaValue({}, 'AWB Number'), '');
});

test('the WordPress batch probe is answered, not 404ed', async () => {
  // Captured live: XpressBees POSTs {"requests":[]} to /wp-json/batch/v1 with
  // NO auth header before pushing any status. A 404 tells them the store
  // cannot take batched writes.
  const { handler } = require('../woo-channel');
  const res = await handler({
    path: '/wp-json/batch/v1', httpMethod: 'POST',
    headers: {}, body: JSON.stringify({ requests: [] }),
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.failed, false);
  assert.deepEqual(body.responses, []);
});

test('a non-empty batch still requires the consumer pair', async () => {
  const { handler } = require('../woo-channel');
  process.env.WOO_CONSUMER_KEY = 'ck_right';
  process.env.WOO_CONSUMER_SECRET = 'cs_right';
  const res = await handler({
    path: '/wp-json/batch/v1', httpMethod: 'POST', headers: {},
    body: JSON.stringify({ requests: [{ method: 'PUT', path: '/wc/v3/orders/5', body: { status: 'completed' } }] }),
  });
  assert.equal(res.statusCode, 401, 'an unauthenticated write must never be acknowledged');
});

// ── The channel carries COD work only ──────────────────────────────────────
// The tests above assert that the feed LABELS a prepaid order correctly, and
// it does. That was never the question. XpressBees's importer does not read
// the label: all 133 shipments it pulled from this channel on 16-18 Sep came
// out Payment Mode = COD, including 54 orders already paid in full and 12 free
// replacements -- Rs 25,042 of doorstep bills to people who had already paid.
// The 41 orders uploaded the same week through the panel's bulk template came
// out 41/41 PREPAID, so the panel is not the problem, the importer is.
//
// What can be tested on our side is what we hand it. These assert the feed
// never offers an order whose payment mode it is relying on someone else to
// read correctly.
{
  const { isCollectOnDelivery } = require('../woo-channel').__test;

  test('a fully paid order is withheld from the COD-only channel', () => {
    assert.equal(
      isCollectOnDelivery(base({ amount_paise: 15900, status: 'paid', razorpay_payment_id: 'OM2609160816317211650242W' })),
      false,
      'IC-20260916-6MATS was booked COD Rs 159 after PhonePe had already collected Rs 159',
    );
  });

  test('a free replacement is withheld from the COD-only channel', () => {
    assert.equal(
      isCollectOnDelivery(base({
        razorpay_order_id: 'IC-R-20260916-PU43R', status: 'replacement_pending',
        amount_paise: 0, razorpay_payment_id: null,
      })),
      false,
      'a reship for a damaged book must never arrive with a Rs 619 bill on it',
    );
  });

  test('a real COD order is still carried', () => {
    assert.equal(
      isCollectOnDelivery(base({ amount_paise: 38800, status: 'cod_pending', razorpay_payment_id: null })),
      true,
      'withholding real COD work would stop shipping entirely',
    );
  });

  test('partial COD is carried, and collects the balance only', async () => {
    const o = base({
      amount_paise: 3400, status: 'partial_cod_pending', razorpay_payment_id: 'pay_advance',
      cart_items: [{ title: 'Atomic Habits', sku: 'AH1', qty: 1, price: 339,
                     _payment: { balance: 305, full_total: 339 } }],
    });
    assert.equal(isCollectOnDelivery(o), true);
    const woo = await toWooOrder(o);
    assert.equal(woo.total, '305.00', 'the importer collects `total`; it must be the balance, not the full value');
    assert.equal(woo.discount_total, '34.00');
  });

  test('a partial-COD order with no balance metadata is withheld, not guessed at', () => {
    assert.equal(
      isCollectOnDelivery(base({ amount_paise: 3400, status: 'partial_cod_pending', razorpay_payment_id: 'pay_advance' })),
      false,
      'failing closed is a late parcel; failing open is charging the advance twice',
    );
  });
}

// WOO_FEED_PREPAID is the only way a prepaid order gets back into the feed, and
// it exists to prove the panel's payment mapping on ONE order before trusting
// it with all of them. The gate must stay shut by default, open exactly as far
// as it is told, and never admit an order the classifier refused to price.
{
  const { feedRole, feedAdmits, prepaidPolicy } = require('../woo-channel').__test;
  const paid = base({ razorpay_order_id: 'IC-20260918-PR0BE', amount_paise: 29900, status: 'paid', razorpay_payment_id: 'OM26091800000000000000W' });
  const cod = base({ razorpay_order_id: 'IC-20260918-C0D00', amount_paise: 38800, status: 'cod_pending', razorpay_payment_id: null });
  const broken = base({ razorpay_order_id: 'IC-20260918-BR0KE', amount_paise: 30500, status: 'partial_cod_pending', advance_paid_paise: 3400, cart_items: [] });

  test('unset WOO_FEED_PREPAID means COD only', () => {
    const policy = prepaidPolicy(undefined);
    assert.equal(feedAdmits(cod, policy), true);
    assert.equal(feedAdmits(paid, policy), false, 'the default must be the state the 66 wrong bookings forced');
    for (const raw of ['0', 'off', 'no', ' ']) {
      const p = prepaidPolicy(raw);
      assert.equal(p.all, false, raw);
      assert.equal(p.ids.size, 0, raw);
    }
  });

  test('"all" admits prepaid, still never the unclassifiable', () => {
    const policy = prepaidPolicy('all');
    assert.equal(feedAdmits(paid, policy), true);
    assert.equal(feedAdmits(cod, policy), true);
    assert.equal(feedRole(broken), 'withhold', 'a partial-COD order with no balance metadata cannot be priced');
    assert.equal(feedAdmits(broken, policy), false, '"all" opens the prepaid gate, not the fail-closed one');
  });

  test('a named order is admitted alone, whatever its case or separator', () => {
    for (const raw of ['IC-20260918-PR0BE', 'ic-20260918-pr0be', 'IC-20260918-XXXXX, IC-20260918-PR0BE', 'IC-20260918-PR0BE IC-20260918-YYYYY']) {
      const policy = prepaidPolicy(raw);
      assert.equal(policy.all, false, raw);
      assert.equal(feedAdmits(paid, policy), true, raw);
    }
    const other = base({ ...paid, razorpay_order_id: 'IC-20260918-OTHER' });
    assert.equal(feedAdmits(other, prepaidPolicy('IC-20260918-PR0BE')), false, 'the probe is one order, not a category');
  });

  test('feedRole distinguishes not-COD from could-not-classify', () => {
    assert.equal(feedRole(cod), 'cod');
    assert.equal(feedRole(paid), 'prepaid');
    assert.equal(feedRole(broken), 'withhold');
  });
}

{
  const { prepaidGateway } = require('../woo-channel').__test;
  test('prepaid gateway defaults to prepaid/Prepaid and honours an override', () => {
    assert.deepEqual(prepaidGateway(undefined), { slug: 'prepaid', title: PREPAID_TITLE });
    assert.deepEqual(prepaidGateway(''), { slug: 'prepaid', title: PREPAID_TITLE });
    assert.deepEqual(prepaidGateway('razorpay|Razorpay'), { slug: 'razorpay', title: 'Razorpay' });
    assert.deepEqual(prepaidGateway(' razorpay | Credit Card/UPI '), { slug: 'razorpay', title: 'Credit Card/UPI' });
    assert.deepEqual(prepaidGateway('razorpay'), { slug: 'razorpay', title: 'razorpay' }, 'a slug alone is its own title');
  });
}

test('a push for an order beyond the first 1,000 in the window still matches', async () => {
  // 27 Sept 2026: the window held ~1,060 orders and a single unordered
  // .limit(1000) dropped the rest, so 10 booked orders never got their AWB.
  const filler = Array.from({ length: 2400 }, (_, i) => ({ id: `f${i}`, razorpay_order_id: `IC-20260901-F${String(i).padStart(4, '0')}`, status: 'shipped' }));
  const target = { id: 'uuid-far', razorpay_order_id: ORDER_NO, status: 'cod_pending' };
  const captured = []; const reads = [];
  const res = await applyPushBack(stubDb([...filler, target], captured, reads), WOO_ID, pushed('On Hold', '143449610845219'));
  assert.equal(res.applied, true);
  assert.equal(captured[0].tracking_id, '143449610845219');
  assert.equal(reads.length, 3, 'walked all three pages');
});

test('an unknown woo id walks the window once and stops', async () => {
  const filler = Array.from({ length: 1500 }, (_, i) => ({ id: `f${i}`, razorpay_order_id: `IC-20260901-G${i}`, status: 'paid' }));
  const reads = [];
  const res = await applyPushBack(stubDb(filler, [], reads), 12345, pushed('On Hold', '143449610845219'));
  assert.equal(res.applied, false);
  assert.match(res.reason, /no order matches/);
  assert.equal(reads.length, 2);
});

test('a booking pushed for an order we cancelled is cancelled with XpressBees, not shipped', async () => {
  // IC-R-20260925-2U7MB: cancelled here while its panel row was still queued;
  // the row was booked anyway and the parcel went out for pickup.
  for (const st of ['cancelled', 'refunded', 'refund_pending', 'refund_failed']) {
    const captured = [];
    const cancelledAwbs = [];
    const xb = { track: async () => ({ status: 'pending pickup' }), cancel: async (awb) => { cancelledAwbs.push(awb); return 'ok'; } };
    const db = stubDb({ id: 'u', razorpay_order_id: ORDER_NO, status: st }, captured);
    const res = await applyPushBack(db, WOO_ID, pushed('On Hold', '143449610819605'), { xb });
    assert.equal(res.applied, false, st);
    assert.equal(res.courier.action, 'cancelled', st);
    assert.deepEqual(cancelledAwbs, ['143449610819605'], st);
    assert.ok(!captured.some(c => c.status === 'shipped'), `${st} must not become shipped`);
  }
});

// ── DTDC (Shipsy) on its own key pair ──────────────────────────────────────

const { bookingFromPush, applyBooking } = require('../woo-channel').__test;

function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(vars)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}
const BOTH = { WOO_CONSUMER_KEY: 'ck_xb', WOO_CONSUMER_SECRET: 'cs_xb', WOO_DTDC_CONSUMER_KEY: 'ck_dt', WOO_DTDC_CONSUMER_SECRET: 'cs_dt' };
const asKey = (key, secret) => ({ headers: {}, queryStringParameters: { consumer_key: key, consumer_secret: secret } });

test('each panel authenticates as itself, and pairs cannot be mixed', () => withEnv(BOTH, () => {
  assert.equal(authorize(asKey('ck_xb', 'cs_xb')).client, 'xpressbees');
  assert.equal(authorize(asKey('ck_dt', 'cs_dt')).client, 'dtdc');
  assert.equal(authorize(asKey('ck_dt', 'cs_xb')).ok, false);
  assert.equal(authorize(asKey('ck_xb', 'cs_dt')).ok, false);
}));

test('the DTDC pair works without the XpressBees pair configured', () => withEnv(
  { WOO_CONSUMER_KEY: '', WOO_CONSUMER_SECRET: '', WOO_DTDC_CONSUMER_KEY: 'ck_dt', WOO_DTDC_CONSUMER_SECRET: 'cs_dt' },
  () => assert.equal(authorize(asKey('ck_dt', 'cs_dt')).client, 'dtdc'),
));

test('a DTDC push is a DTDC booking whatever its Courier Name meta says', () => {
  const b = bookingFromPush({ status: 'processing', meta_data: [{ key: 'Courier Name', value: 'Xpressbees' }, { key: 'AWB Number', value: 'D12345678' }] }, 'dtdc');
  assert.deepEqual(b, { awb: 'D12345678', courier: 'DTDC' });
});

test('DTDC consignment numbers are found where WooCommerce integrations put them', () => {
  assert.equal(bookingFromPush({ status: 'completed', meta_data: [{ key: '_wc_shipment_tracking_items', value: [{ tracking_provider: 'DTDC', tracking_number: 'Z98765432' }] }] }, 'dtdc').awb, 'Z98765432');
  assert.equal(bookingFromPush({ status: 'completed', meta_data: [{ key: 'consignment_number', value: 'V76512341' }] }, 'dtdc').awb, 'V76512341');
  assert.equal(bookingFromPush({ status: 'on-hold', tracking_number: 'D11112222' }, 'dtdc').awb, 'D11112222');
});

test('DTDC cancel / RTO / no-number pushes are recorded only', () => {
  for (const status of ['cancelled', 'RTO Delivered', 'RTO Initiated']) {
    assert.ok(!bookingFromPush({ status, meta_data: [{ key: 'AWB Number', value: 'D12345678' }] }, 'dtdc').awb, status);
  }
  assert.ok(!bookingFromPush({ status: 'processing', meta_data: [] }, 'dtdc').awb);
  assert.ok(!bookingFromPush({ status: 'processing', meta_data: [{ key: 'awb', value: 'x' }] }, 'dtdc').awb, 'too short to be an AWB');
});

test('the XpressBees pair keeps its exact old rule', () => {
  assert.ok(!bookingFromPush({ status: 'processing', meta_data: [{ key: 'AWB Number', value: '143449610504655' }] }, 'xpressbees').awb);
  assert.equal(bookingFromPush(pushed('On Hold', '143449610504655'), 'xpressbees').courier, 'Xpressbees');
});

test('a DTDC booking ships the order with a DTDC tracking link', async () => {
  const captured = [];
  const db = stubDb({ id: 'u', razorpay_order_id: ORDER_NO, status: 'cod_pending' }, captured);
  const res = await applyPushBack(db, WOO_ID, { status: 'processing', meta_data: [{ key: 'AWB Number', value: 'D12345678' }] }, { client: 'dtdc', ownerAlert: async () => assert.fail('no alert') });
  assert.equal(res.applied, true, res.reason);
  assert.equal(captured[0].courier_name, 'DTDC');
  assert.equal(captured[0].tracking_id, 'D12345678');
  assert.match(captured[0].tracking_url, /dtdc\.in/);
});

test('an order already booked with another courier is never overwritten, and the owner is told', async () => {
  const captured = [];
  const alerts = [];
  const db = stubDb({ id: 'u', razorpay_order_id: ORDER_NO, status: 'shipped', tracking_id: '143449610504655', courier_name: 'Xpressbees' }, captured);
  const res = await applyBooking(db, WOO_ID, { awb: 'D12345678', courier: 'DTDC' }, { ownerAlert: async (t) => alerts.push(t) });
  assert.equal(res.applied, false);
  assert.equal(captured.length, 0);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /booked twice/);
  // And the other way round: XpressBees cannot overwrite a DTDC booking.
  const db2 = stubDb({ id: 'u', razorpay_order_id: ORDER_NO, status: 'shipped', tracking_id: 'D12345678', courier_name: 'DTDC' }, captured);
  const res2 = await applyPushBack(db2, WOO_ID, pushed('On Hold', '143449610504655'), { ownerAlert: async (t) => alerts.push(t) });
  assert.equal(res2.applied, false);
  assert.equal(captured.length, 0);
});

test('the same courier rebooking with a new AWB still goes through', async () => {
  const captured = [];
  const db = stubDb({ id: 'u', razorpay_order_id: ORDER_NO, status: 'shipped', tracking_id: '143449610500000', courier_name: 'XpressBees' }, captured);
  const res = await applyPushBack(db, WOO_ID, pushed('On Hold', '143449610504655'), { ownerAlert: async () => assert.fail('no alert') });
  assert.equal(res.applied, true, res.reason);
});

test('DTDC booking a cancelled order alerts the owner, since only XpressBees can be cancelled from here', async () => {
  const captured = [];
  const alerts = [];
  const db = stubDb({ id: 'u', razorpay_order_id: ORDER_NO, status: 'cancelled' }, captured);
  const res = await applyBooking(db, WOO_ID, { awb: 'D12345678', courier: 'DTDC' }, { ownerAlert: async (t) => alerts.push(t) });
  assert.equal(res.applied, false);
  assert.equal(res.courier.action, 'not_supported');
  assert.match(alerts[0], /Cancelled order booked/);
  assert.ok(!captured.some(c => c.status === 'shipped'));
});

test('shipment-tracking POST with the XpressBees pair is recorded, never applied', async () => withEnv(BOTH, async () => {
  const { handler } = require('../woo-channel');
  const res = await handler({
    path: `/wp-json/wc-ast/v3/orders/${WOO_ID}/shipment-trackings`, httpMethod: 'POST', headers: {},
    queryStringParameters: { consumer_key: 'ck_xb', consumer_secret: 'cs_xb' },
    body: JSON.stringify({ tracking_provider: 'DTDC', tracking_number: 'D12345678' }),
  });
  assert.equal(res.statusCode, 201);
}));

test('shipment-tracking and webhook routes still require a key pair', async () => withEnv(BOTH, async () => {
  const { handler } = require('../woo-channel');
  for (const path of [`/wp-json/wc-ast/v3/orders/${WOO_ID}/shipment-trackings`, '/wp-json/wc/v3/webhooks', `/wp-json/wc/v3/orders/${WOO_ID}/notes`]) {
    const res = await handler({ path, httpMethod: 'POST', headers: {}, queryStringParameters: {}, body: '{}' });
    assert.equal(res.statusCode, 401, path);
  }
}));
