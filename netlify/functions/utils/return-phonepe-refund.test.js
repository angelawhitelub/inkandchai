'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { payReturnByPhonePe, settleReturnRefundEvent, syncReturnRefunds } = require('./return-auto-refund');
const { refundUtrFrom } = require('./phonepe-core');

// A tiny stand-in for the Supabase query builder: records every update with its
// filters, and answers selects from the rows it was given.
function match(r, [op, k, v]) {
  if (op === 'is') return r[k] == null;
  if (op === 'like') return String(r[k] || '').startsWith(v.replace(/%$/, ''));
  if (op === 'gte') return String(r[k] || '') >= v;
  return r[k] === v;
}

function fakeDb(rows = {}) {
  const updates = [];
  function builder(table) {
    const q = { table, filters: [], patch: null };
    const api = {
      update(patch) { q.patch = patch; return api; },
      select() { return api; },
      eq(k, v) { q.filters.push(['eq', k, v]); return api; },
      like(k, v) { q.filters.push(['like', k, v]); return api; },
      gte(k, v) { q.filters.push(['gte', k, v]); return api; },
      is(k, v) { q.filters.push(['is', k, v]); return api; },
      maybeSingle() {
        const hit = (rows[table] || []).find(r => q.filters.every(f => match(r, f)));
        return Promise.resolve({ data: hit || null, error: null });
      },
      then(res, rej) {
        if (q.patch) {
          updates.push({ table, patch: q.patch, filters: q.filters });
          const hits = (rows[table] || []).filter(r => q.filters.every(f => match(r, f)));
          hits.forEach(r => Object.assign(r, q.patch));
          return Promise.resolve({ data: hits.map(r => ({ id: r.id })), error: null }).then(res, rej);
        }
        const hits = (rows[table] || []).filter(r => q.filters.every(f => match(r, f)));
        return Promise.resolve({ data: hits, error: null }).then(res, rej);
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
const quiet = { ownerAlert: async () => {}, sendRefundInitiated: async () => ({}), getRefundStatus: async () => ({ ok: true, state: 'PENDING', data: {} }) };

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
  const r = { id: 'r1', order_id: 'o1', order_display_id: 'IC-X', refund_status: 'refunded', refund_ref: 'REFUND-IC-X-A0', refund_amount_paise: 100 };
  const o = order({ id: 'o1' });
  const db = fakeDb({ return_requests: [r], orders: [o] });
  assert.equal(await settleReturnRefundEvent(db, 'REFUND-IC-Y-A0', 'COMPLETED', quiet), null);
  const done = await settleReturnRefundEvent(db, 'REFUND-IC-X-A0', 'COMPLETED', quiet,
    { refundId: 'OMR1', splitInstruments: [{ rail: { type: 'UPI', utr: '632447199012' } }] });
  assert.deepEqual(done, { return_refund: 'IC-X', refund_status: 'refunded', refund_utr: '632447199012' });
  assert.equal(o.refund_utr, '632447199012');
  assert.equal(o.phonepe_refund_id, 'OMR1');
  assert.equal(o.status, 'delivered');
  let alerted = 0;
  await settleReturnRefundEvent(db, 'REFUND-IC-X-A0', 'FAILED', { ownerAlert: async () => { alerted++; } });
  assert.equal(r.refund_status, 'manual_refund_pending');
  assert.equal(alerted, 1);
});

test('COMPLETED tells the customer once, quoting the UTR', async () => {
  const r = { id: 'r1', order_id: 'o1', order_display_id: 'IC-X', refund_status: 'refunded', refund_ref: 'REFUND-IC-X-A0', refund_amount_paise: 54000 };
  const o = order({ id: 'o1' });
  const db = fakeDb({ return_requests: [r], orders: [o] });
  const sent = [];
  const deps = { ...quiet, sendRefundInitiated: async (ord, paise, opts) => { sent.push([paise, opts.refundRef]); ord.refund_notified_at = 'now'; } };
  const payload = { splitInstruments: [{ rail: { utr: '111' } }] };
  await settleReturnRefundEvent(db, 'REFUND-IC-X-A0', 'COMPLETED', deps, payload);
  await settleReturnRefundEvent(db, 'REFUND-IC-X-A0', 'COMPLETED', deps, payload);
  assert.deepEqual(sent, [[54000, '111']]);
});

test('refundUtrFrom reads the documented splitInstruments shape, paymentDetails, and NetBanking brn', () => {
  assert.equal(refundUtrFrom({ state: 'COMPLETED', splitInstruments: [{ rail: { type: 'UPI', utr: '586756785' } }] }), '586756785');
  assert.equal(refundUtrFrom({ paymentDetails: [{ state: 'COMPLETED', rail: { utr: '42' } }] }), '42');
  assert.equal(refundUtrFrom({ paymentDetails: [{ state: 'COMPLETED', splitInstruments: [{ rail: { utr: '7' } }] }] }), '7');
  assert.equal(refundUtrFrom({ splitInstruments: [{ rail: { type: 'PG' }, instrument: { bankId: 'X', brn: 'brn123' } }] }), 'brn123');
  assert.equal(refundUtrFrom({ paymentDetails: [{ paymentMode: 'CARD', state: 'COMPLETED' }] }), null);
});

test('hourly sync closes a return whose order was refunded from the order row', async () => {
  const r = { id: 'r1', order_id: 'o1', order_display_id: 'IC-20261028-VCPOK', refund_status: 'manual_refund_pending', payment_type: 'prepaid', refund_method: 'original' };
  const o = order({ id: 'o1', status: 'refunded', refund_state: 'COMPLETED', refund_id: 'REFUND-IC-20261028-VCPOK-A0', refund_utr: '632447199012', refund_notified_at: 'x', refund_updated_at: '2026-11-20T17:47:33Z' });
  const db = fakeDb({ return_requests: [r], orders: [o] });
  const out = await syncReturnRefunds(db, quiet);
  assert.deepEqual(out.closed, ['IC-20261028-VCPOK']);
  assert.equal(r.refund_status, 'refunded');
  assert.equal(r.refund_ref, 'REFUND-IC-20261028-VCPOK-A0');
  // A partly refunded order is not enough to close a return.
  const r2 = { ...r, id: 'r2', refund_status: 'manual_refund_pending' };
  const db2 = fakeDb({ return_requests: [r2], orders: [order({ id: 'o1', status: 'partially_refunded', refund_state: 'COMPLETED' })] });
  assert.deepEqual((await syncReturnRefunds(db2, quiet)).closed, []);
});
