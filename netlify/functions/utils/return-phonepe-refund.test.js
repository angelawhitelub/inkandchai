'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { payReturnByPhonePe, settleReturnRefundEvent } = require('./return-auto-refund');

// A tiny stand-in for the Supabase query builder: records every update with its
// filters, and answers selects from the rows it was given.
function fakeDb(rows = {}) {
  const updates = [];
  function builder(table) {
    const q = { table, filters: [], patch: null };
    const api = {
      update(patch) { q.patch = patch; return api; },
      select() { return api; },
      eq(k, v) { q.filters.push(['eq', k, v]); return api; },
      is(k, v) { q.filters.push(['is', k, v]); return api; },
      maybeSingle() {
        const hit = (rows[table] || []).find(r => q.filters.every(([, k, v]) => r[k] === v));
        return Promise.resolve({ data: hit || null, error: null });
      },
      then(res, rej) {
        if (q.patch) {
          updates.push({ table, patch: q.patch, filters: q.filters });
          const hits = (rows[table] || []).filter(r => q.filters.every(([op, k, v]) => op === 'is' ? r[k] == null : r[k] === v));
          hits.forEach(r => Object.assign(r, q.patch));
          return Promise.resolve({ data: hits.map(r => ({ id: r.id })), error: null }).then(res, rej);
        }
        return Promise.resolve({ data: [], error: null }).then(res, rej);
      },
    };
    return api;
  }
  return { from: builder, updates };
}

const ret = (o = {}) => ({ id: 'r1', order_id: 'o1', order_display_id: 'IC-20261028-VCPOK', refund_amount_paise: 54000,
  customer_email: 'c@example.com', customer_name: 'Asha K', refund_status: 'refunding', ...o });
const order = (o = {}) => ({ id: 'o1', razorpay_order_id: 'IC-20261028-VCPOK', razorpay_payment_id: 'OM261028X',
  amount_paise: 54000, status: 'delivered', refund_attempts: 0, ...o });
const quiet = { ownerAlert: async () => {}, sendEmail: async () => {} };

test('a received PhonePe return is refunded with the attempt-numbered id, order left delivered', async () => {
  const o = order(); const r = ret();
  const db = fakeDb({ orders: [o], return_requests: [r] });
  const calls = [];
  const out = await payReturnByPhonePe(db, r, o, { ...quiet,
    issuePhonePeRefund: async (a) => { calls.push(a); return { ok: true, state: 'PENDING', merchantRefundId: 'REFUND-IC-20261028-VCPOK-A0' }; } });
  assert.equal(out.ok, true);
  assert.deepEqual(calls, [{ displayId: 'IC-20261028-VCPOK', amountPaise: 54000, attempt: 0 }]);
  assert.equal(r.refund_status, 'refunded');
  assert.equal(r.refund_ref, 'REFUND-IC-20261028-VCPOK-A0');
  assert.equal(o.refund_attempts, 1);
  assert.equal(o.status, 'delivered');
});

test('PhonePe refusing leaves the return on manual with the id kept', async () => {
  const o = order(); const r = ret();
  const db = fakeDb({ orders: [o], return_requests: [r] });
  const out = await payReturnByPhonePe(db, r, o, { ...quiet,
    issuePhonePeRefund: async () => ({ ok: false, error: 'nope', merchantRefundId: 'REFUND-IC-20261028-VCPOK-A0' }) });
  assert.equal(out.ok, false);
  assert.equal(r.refund_status, 'manual_refund_pending');
  assert.equal(r.refund_ref, 'REFUND-IC-20261028-VCPOK-A0');
});

test('an earlier attempt that PhonePe completed is never paid again', async () => {
  const o = order({ refund_attempts: 1 }); const r = ret({ refund_ref: 'REFUND-IC-20261028-VCPOK-A0' });
  const db = fakeDb({ orders: [o], return_requests: [r] });
  let issued = 0;
  const out = await payReturnByPhonePe(db, r, o, { ...quiet,
    getRefundStatus: async () => ({ ok: true, state: 'COMPLETED', data: {} }),
    issuePhonePeRefund: async () => { issued++; return { ok: true }; } });
  assert.equal(out.ok, true);
  assert.equal(issued, 0);
  assert.equal(r.refund_status, 'refunded');
});

test('an earlier attempt in an unknown state blocks a new one', async () => {
  const o = order({ refund_attempts: 1 }); const r = ret({ refund_ref: 'REFUND-IC-20261028-VCPOK-A0' });
  const db = fakeDb({ orders: [o], return_requests: [r] });
  let issued = 0;
  const out = await payReturnByPhonePe(db, r, o, { ...quiet,
    getRefundStatus: async () => ({ ok: false, state: '', data: { message: 'timeout' } }),
    issuePhonePeRefund: async () => { issued++; return { ok: true }; } });
  assert.equal(out.ok, false);
  assert.equal(issued, 0);
  assert.equal(r.refund_status, 'manual_refund_pending');
});

test('refuses Razorpay, over-total and already-refunded orders without calling PhonePe', async () => {
  for (const [o, why] of [
    [order({ razorpay_payment_id: 'pay_abc' }), /Razorpay/],
    [order({ amount_paise: 30000 }), /more than the order total/],
    [order({ refund_state: 'COMPLETED' }), /already shows a refund/],
  ]) {
    const r = ret();
    const db = fakeDb({ orders: [o], return_requests: [r] });
    const out = await payReturnByPhonePe(db, r, o, { ...quiet, issuePhonePeRefund: async () => { throw new Error('must not call'); } });
    assert.equal(out.ok, false);
    assert.match(out.error, why);
    assert.equal(r.refund_status, 'manual_refund_pending');
  }
});

test('webhook: return refund events settle the return, others fall through', async () => {
  const r = { id: 'r1', order_display_id: 'IC-X', refund_status: 'refunded', refund_ref: 'REFUND-IC-X-A0', refund_amount_paise: 100 };
  const db = fakeDb({ return_requests: [r] });
  assert.equal(await settleReturnRefundEvent(db, 'REFUND-IC-Y-A0', 'COMPLETED', quiet), null);
  assert.deepEqual(await settleReturnRefundEvent(db, 'REFUND-IC-X-A0', 'COMPLETED', quiet), { return_refund: 'IC-X', refund_status: 'refunded' });
  let alerted = 0;
  await settleReturnRefundEvent(db, 'REFUND-IC-X-A0', 'FAILED', { ownerAlert: async () => { alerted++; } });
  assert.equal(r.refund_status, 'manual_refund_pending');
  assert.equal(alerted, 1);
});
