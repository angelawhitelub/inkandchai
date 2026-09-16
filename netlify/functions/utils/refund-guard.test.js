const { test } = require('node:test');
const assert = require('node:assert');

const { assertRefundablePayment, NonRefundableError } = require('./refund-guard');

const realFetch = global.fetch;
function stubFetch(routes) {
  global.fetch = async (url) => {
    for (const [frag, value] of Object.entries(routes)) {
      if (String(url).includes(frag)) {
        if (value instanceof Error) throw value;
        if (value.status && value.status >= 400) {
          return { ok: false, status: value.status, json: async () => value.body || {} };
        }
        return { ok: true, status: 200, json: async () => value };
      }
    }
    throw new Error('unexpected fetch ' + url);
  };
}

function withCreds(fn) {
  return async (...args) => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_x';
    process.env.RAZORPAY_KEY_SECRET = 'secret';
    try { return await fn(...args); }
    finally { global.fetch = realFetch; }
  };
}

const dbWith = (row) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row }) }) }) }) });

test('refuses when the PAYMENT is tagged as an ebook', withCreds(async () => {
  stubFetch({ '/payments/pay_1': { id: 'pay_1', notes: { kind: 'ebook' } } });
  await assert.rejects(() => assertRefundablePayment('pay_1'), NonRefundableError);
}));

test('refuses when only the ORDER is tagged (notes did not propagate)', withCreds(async () => {
  stubFetch({
    '/payments/pay_2': { id: 'pay_2', order_id: 'order_2', notes: {} },
    '/orders/order_2': { id: 'order_2', notes: { kind: 'ebook', slug: 'x' } },
  });
  await assert.rejects(() => assertRefundablePayment('pay_2'), NonRefundableError);
}));

test('refuses when an entitlement row carries the payment id', withCreds(async () => {
  stubFetch({
    '/payments/pay_3': { id: 'pay_3', order_id: 'order_3', notes: {} },
    '/orders/order_3': { id: 'order_3', notes: {} },
  });
  await assert.rejects(
    () => assertRefundablePayment('pay_3', { supabase: dbWith({ id: 7 }) }),
    NonRefundableError);
}));

test('allows an ordinary book payment through', withCreds(async () => {
  stubFetch({
    '/payments/pay_4': { id: 'pay_4', order_id: 'order_4', notes: { customer_name: 'A' } },
    '/orders/order_4': { id: 'order_4', notes: { customer_name: 'A' } },
  });
  await assert.doesNotReject(() => assertRefundablePayment('pay_4', { supabase: dbWith(null) }));
}));

test('case and spacing in the note do not get past it', withCreds(async () => {
  stubFetch({ '/payments/pay_5': { id: 'pay_5', notes: { kind: 'EBook' } } });
  await assert.rejects(() => assertRefundablePayment('pay_5'), NonRefundableError);
}));

test('fails CLOSED when the payment cannot be looked up', withCreds(async () => {
  stubFetch({ '/payments/pay_6': { status: 500, body: {} } });
  await assert.rejects(() => assertRefundablePayment('pay_6'), (e) => !e.nonRefundable);
}));

test('fails CLOSED when the order lookup errors', withCreds(async () => {
  stubFetch({
    '/payments/pay_7': { id: 'pay_7', order_id: 'order_7', notes: {} },
    '/orders/order_7': new Error('network down'),
  });
  await assert.rejects(() => assertRefundablePayment('pay_7'));
}));

test('a broken entitlement lookup does not block a real refund', withCreds(async () => {
  stubFetch({
    '/payments/pay_8': { id: 'pay_8', order_id: 'order_8', notes: {} },
    '/orders/order_8': { id: 'order_8', notes: {} },
  });
  const broken = { from: () => { throw new Error('no such table'); } };
  await assert.doesNotReject(() => assertRefundablePayment('pay_8', { supabase: broken }));
}));

test('issueRazorpayRefund runs the guard before charging anything', withCreds(async () => {
  const { issueRazorpayRefund } = require('./razorpay-refund');
  let refundCalled = false;
  global.fetch = async (url) => {
    if (String(url).includes('/refund')) { refundCalled = true; return { ok: true, status: 200, json: async () => ({}) }; }
    if (String(url).includes('/payments/pay_9')) return { ok: true, status: 200, json: async () => ({ id: 'pay_9', notes: { kind: 'ebook' } }) };
    throw new Error('unexpected ' + url);
  };
  await assert.rejects(() => issueRazorpayRefund('pay_9', 0), NonRefundableError);
  assert.equal(refundCalled, false, 'no refund may be created for an ebook payment');
}));
