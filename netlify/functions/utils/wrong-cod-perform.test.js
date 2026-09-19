'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { performWrongCodRefund } = require('./wrong-cod-refund');

// A Supabase stub that records every update it is asked to make and lets the
// test decide whether the conditional claim was won.
function fakeDb({ claimWins = true } = {}) {
  const updates = [];
  return {
    updates,
    from() {
      return {
        update(patch) {
          const rec = { patch, conditional: false };
          const chain = {
            eq() { return chain; },
            is() { rec.conditional = true; return chain; },
            select() { return chain; },
            async maybeSingle() { updates.push(rec); return { data: claimWins ? { id: 'x' } : null, error: null }; },
            then(res) { updates.push(rec); return Promise.resolve({ data: null, error: null }).then(res); },
          };
          return chain;
        },
      };
    },
  };
}

const order = {
  id: 'uuid-1',
  razorpay_order_id: 'IC-20260916-0R36N',
  razorpay_payment_id: 'pay_abc123',
  status: 'delivered',
  wrong_cod_paise: 36820,
  wrong_cod_refund_at: null,
};
const noop = async () => ({ sent: true });

test('a refundable order is claimed, charged back and recorded', async () => {
  const db = fakeDb();
  const calls = [];
  const res = await performWrongCodRefund({
    supabase: db, order, source: 'test',
    deps: {
      issueRazorpayRefund: async (pid, paise) => { calls.push({ pid, paise }); return { id: 'rfnd_1' }; },
      issuePhonePeRefund: async () => { throw new Error('wrong gateway'); },
      notifyOwnerRefund: noop,
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.ref, 'rfnd_1');
  assert.deepEqual(calls, [{ pid: 'pay_abc123', paise: 36820 }]);
  assert.equal(db.updates[0].conditional, true, 'the claim must be conditional');
  assert.equal(db.updates[1].patch.wrong_cod_refund_ref, 'rfnd_1');
});

test('the refund never touches order status — the customer keeps the book', async () => {
  const db = fakeDb();
  await performWrongCodRefund({
    supabase: db, order, source: 'test',
    deps: { issueRazorpayRefund: async () => ({ id: 'r' }), issuePhonePeRefund: async () => ({}), notifyOwnerRefund: noop },
  });
  for (const u of db.updates) {
    assert.ok(!('status' in u.patch), `status must not be written: ${JSON.stringify(u.patch)}`);
  }
});

test('the amount charged back comes from the row, never from a caller', async () => {
  const db = fakeDb();
  let charged = null;
  await performWrongCodRefund({
    supabase: db, order: { ...order, wrong_cod_paise: 18900, amount_paise: 999999 }, source: 'test',
    deps: { issueRazorpayRefund: async (_p, paise) => { charged = paise; return { id: 'r' }; }, issuePhonePeRefund: async () => ({}), notifyOwnerRefund: noop },
  });
  assert.equal(charged, 18900);
});

test('losing the claim means someone else is already paying — no second refund', async () => {
  const db = fakeDb({ claimWins: false });
  let called = false;
  const res = await performWrongCodRefund({
    supabase: db, order, source: 'test',
    deps: { issueRazorpayRefund: async () => { called = true; return { id: 'r' }; }, issuePhonePeRefund: async () => ({}), notifyOwnerRefund: noop },
  });
  assert.equal(res.ok, false);
  assert.equal(res.verdict, 'already-done');
  assert.equal(called, false, 'the gateway must not be touched after losing the claim');
});

test('a gateway failure hands the claim back so a retry can still pay them', async () => {
  const db = fakeDb();
  const res = await performWrongCodRefund({
    supabase: db, order, source: 'test',
    deps: { issueRazorpayRefund: async () => { throw new Error('card network down'); }, issuePhonePeRefund: async () => ({}), notifyOwnerRefund: noop },
  });
  assert.equal(res.ok, false);
  assert.equal(res.verdict, 'gateway-failed');
  const release = db.updates[db.updates.length - 1].patch;
  assert.equal(release.wrong_cod_refund_at, null);
  assert.match(release.wrong_cod_refund_ref, /card network down/);
});

test('a PhonePe payment goes to PhonePe, not Razorpay', async () => {
  const db = fakeDb();
  let usedPhonePe = false;
  const res = await performWrongCodRefund({
    supabase: db, order: { ...order, razorpay_payment_id: 'OMR2608XYZ' }, source: 'test',
    deps: {
      issueRazorpayRefund: async () => { throw new Error('wrong gateway'); },
      issuePhonePeRefund: async () => { usedPhonePe = true; return { ok: true, merchantRefundId: 'REFUND-1' }; },
      notifyOwnerRefund: noop,
    },
  });
  assert.equal(usedPhonePe, true);
  assert.equal(res.ref, 'REFUND-1');
});

test('an undelivered order never reaches the gateway or the claim', async () => {
  const db = fakeDb();
  let called = false;
  const res = await performWrongCodRefund({
    supabase: db, order: { ...order, status: 'shipped' }, source: 'test',
    deps: { issueRazorpayRefund: async () => { called = true; return { id: 'r' }; }, issuePhonePeRefund: async () => ({}), notifyOwnerRefund: noop },
  });
  assert.equal(res.ok, false);
  assert.equal(res.verdict, 'not-delivered');
  assert.equal(called, false);
  assert.equal(db.updates.length, 0, 'nothing should be written for an ineligible order');
});

test('an order with no original payment is never refunded blind', async () => {
  const db = fakeDb();
  const res = await performWrongCodRefund({
    supabase: db, order: { ...order, razorpay_payment_id: null }, source: 'test',
    deps: { issueRazorpayRefund: async () => ({ id: 'r' }), issuePhonePeRefund: async () => ({}), notifyOwnerRefund: noop },
  });
  assert.equal(res.verdict, 'no-payment-id');
  assert.equal(db.updates.length, 0);
});
