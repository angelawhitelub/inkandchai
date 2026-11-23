'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const PL = require('./pay-later');
const M = require('./pay-later-mandate');

function fakeDb(rows) {
  return {
    from() {
      const q = { filters: [], patch: null };
      const api = {
        select() { return api; }, limit() { return api; }, order() { return api; },
        update(p) { q.patch = p; return api; },
        eq(k, v) { if (!k.includes('->')) q.filters.push((r) => r[k] === v); return api; },
        is(k, v) { q.filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return api; },
        then(res, rej) {
          const hits = rows.filter((r) => q.filters.every((f) => f(r)));
          if (q.patch) hits.forEach((r) => Object.assign(r, q.patch));
          return Promise.resolve({ data: q.patch ? hits.map((r) => ({ id: r.id })) : hits, error: null }).then(res, rej);
        },
      };
      return api;
    },
  };
}
const order = (pay = {}, o = {}) => ({
  id: 'o1', razorpay_order_id: 'IC-20261124-ABCDE', razorpay_payment_id: null, amount_paise: 56900, status: 'pay_later_review',
  customer_name: 'Asha K', customer_phone: '9800000000', customer_email: 'a@example.com',
  cart_items: [{ slug: 'peer-e-kamil', title: 'Peer e Kamil', qty: 1, _payment: { mode: 'pay_later', state: 'review', ...pay } }], ...o,
});
function fakeRp(answers) {
  const calls = [];
  return { calls, rp: async (method, path, body) => { calls.push({ method, path, body }); const a = answers(method, path, body); if (a instanceof Error) throw a; return a; } };
}

test('only the browser holding the key can start AutoPay', () => {
  const key = M.newKey();
  const o = order({ mandate_key_hash: M.hashKey(key) });
  assert.equal(M.keyMatches(o, key), true);
  assert.equal(M.keyMatches(o, M.newKey()), false);
  assert.equal(M.keyMatches(order(), key), false);
});

test('UPI AutoPay: ₹1 approval order with an as-presented token capped at the order total', async () => {
  const o = order(); const db = fakeDb([o]);
  const f = fakeRp((m, p) => (p === '/customers' ? { id: 'cust_1' } : { id: 'order_auth', amount: 100 }));
  const r = await M.startMandate(db, o, 'upi', null, { rp: f.rp });
  const auth = f.calls[1].body;
  assert.equal(auth.amount, 100);
  assert.equal(auth.method, 'upi');
  assert.equal(auth.customer_id, 'cust_1');
  assert.equal(auth.token.frequency, 'as_presented');
  assert.equal(auth.token.max_amount, 56900);
  assert.deepEqual(auth.notes, { kind: 'pay_later_mandate', order_id: 'IC-20261124-ABCDE' });
  assert.equal(r.order_id, 'order_auth');
  assert.equal(M.mandateOf(o).status, 'started');
  // The ₹1 approval never becomes the order's payment.
  assert.equal(o.razorpay_payment_id, null);
});

test('bank mandate uses the account the customer typed, ₹0, and waits for the bank', async () => {
  const o = order(); const db = fakeDb([o]);
  const f = fakeRp((m, p) => {
    if (p === '/customers') return { id: 'cust_1' };
    if (p === '/orders') return { id: 'order_auth', amount: 0 };
    if (p.startsWith('/payments/')) return { id: 'pay_a', order_id: 'order_auth', status: 'captured', token_id: 'token_9' };
    if (p.endsWith('/tokens')) return { items: [{ id: 'token_9', method: 'emandate', recurring_details: { status: 'initiated' } }] };
    return {};
  });
  await M.startMandate(db, o, 'emandate', { pan_name: 'ASHA KHAN', account: '123456789012', ifsc: 'sbin0001234' }, { rp: f.rp });
  const auth = f.calls[1].body;
  assert.equal(auth.amount, 0);
  assert.deepEqual(auth.token.bank_account, { beneficiary_name: 'ASHA KHAN', account_number: '123456789012', account_type: 'savings', ifsc_code: 'SBIN0001234' });
  const v = await M.recordApproval(db, o, 'pay_a', { rp: f.rp });
  assert.equal(v.status, 'pending');
  assert.equal(M.mandateOf(o).token_id, 'token_9');
  // A payment from another order is refused.
  const o2 = order({ mandate: { method: 'upi', status: 'started', auth_order_id: 'order_other', customer_id: 'cust_1' } });
  const bad = await M.recordApproval(fakeDb([o2]), o2, 'pay_a', { rp: f.rp });
  assert.equal(bad.ok, false);
});

test('charging an active mandate: one Razorpay order, saved before the debit, notes mark it Pay Later', async () => {
  const o = order({ mandate: { method: 'upi', status: 'active', customer_id: 'cust_1', token_id: 'token_1', max_amount: 56900 } }, { status: 'delivered' });
  const db = fakeDb([o]);
  const f = fakeRp((m, p) => (p === '/orders' ? { id: 'order_chg' } : { razorpay_payment_id: 'pay_chg' }));
  const r = await M.chargeMandate(db, o, { rp: f.rp });
  assert.equal(r.ok, true);
  const rec = f.calls[1].body;
  assert.equal(f.calls[1].path, '/payments/create/recurring');
  assert.equal(rec.token, 'token_1');
  assert.equal(rec.amount, 56900);
  assert.deepEqual(rec.notes, { kind: 'pay_later', order_id: 'IC-20261124-ABCDE', via: 'autopay' });
  assert.equal(M.mandateOf(o).charge_status, 'pending');
  assert.equal((await M.chargeMandate(db, o, { rp: f.rp })).already, true);
  assert.equal(f.calls.length, 2);
});

test('a failed debit is only given up after Razorpay\'s retry days', async () => {
  const charged = new Date(Date.now() - 86400000).toISOString();
  const o = order({ mandate: { method: 'upi', status: 'active', customer_id: 'c', token_id: 't', charge_order_id: 'order_chg', charge_status: 'pending', charged_at: charged } }, { status: 'delivered' });
  const db = fakeDb([o]);
  const f = fakeRp(() => ({ items: [{ id: 'pay_x', status: 'failed', error_description: 'insufficient balance' }] }));
  assert.equal((await M.syncCharge(db, o, { rp: f.rp })).failed, undefined);
  const later = await M.syncCharge(db, o, { rp: f.rp, now: Date.now() + 5 * 86400000 });
  assert.equal(later.failed, true);
  assert.equal(M.mandateOf(o).charge_status, 'failed');
});

test('a captured debit marks the order paid and cancels the mandate', async () => {
  const o = order({ mandate: { method: 'upi', status: 'active', customer_id: 'c', token_id: 't', charge_order_id: 'order_chg', charge_status: 'pending', charged_at: new Date().toISOString() } }, { status: 'delivered' });
  const db = fakeDb([o]);
  const f = fakeRp((m, p) => (p.endsWith('/payments') ? { items: [{ id: 'pay_ok', status: 'captured' }] } : { status: 'cancellation_initiated' }));
  const alerts = [];
  const r = await M.syncCharge(db, o, { rp: f.rp, ownerAlert: async (t) => alerts.push(t) });
  assert.equal(r.paid, true);
  assert.equal(o.razorpay_payment_id, 'pay_ok');
  assert.equal(PL.isUnpaidPayLater(o), false);
  assert.ok(f.calls.some((c) => c.method === 'PUT' && c.path === '/customers/c/tokens/t/cancel'));
  assert.equal(M.mandateOf(o).status, 'cancelled');
  assert.match(alerts[0], /AutoPay/);
});

test('the hourly job charges AutoPay on delivery instead of sending a link', async () => {
  const { handle } = require('../pay-later-scheduled')._test;
  const o = order({ state: 'approved', mandate: { method: 'upi', status: 'active', customer_id: 'c', token_id: 't', max_amount: 56900 } }, { status: 'delivered' });
  const db = fakeDb([o]);
  const f = fakeRp((m, p) => (p === '/orders' ? { id: 'order_chg' } : { razorpay_payment_id: 'pay_chg' }));
  let links = 0;
  const out = JSON.parse((await handle({}, { db, skipAuth: true, rp: f.rp, createLink: async () => { links++; return { id: 'pl', short_url: 'u' }; }, paymentLinkEmail: async () => ({ sent: true }), ownerAlert: async () => {} })).body);
  assert.deepEqual(out.charged, ['IC-20261124-ABCDE']);
  assert.equal(links, 0);
  assert.equal(PL.payLaterMeta(o).state, 'autopay_charged');
  assert.ok(PL.payLaterMeta(o).due_at);
});
