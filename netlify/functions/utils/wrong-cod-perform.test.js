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

// ── Auto-refund on delivery ──────────────────────────────────────────────────
const { autoRefundOnDelivery, autoRefundEnabled, refundedEmail } = require('./wrong-cod-refund');

function fakeDbWithRow(row, opts = {}) {
  const db = fakeDb(opts);
  const from = db.from.bind(db);
  db.from = () => {
    const base = from();
    return {
      ...base,
      select() { return { eq() { return { async maybeSingle() { return { data: row, error: null }; } }; } }; },
    };
  };
  return db;
}

function withEnv(value, fn) {
  const had = process.env.WRONG_COD_AUTO_REFUND;
  if (value === null) delete process.env.WRONG_COD_AUTO_REFUND;
  else process.env.WRONG_COD_AUTO_REFUND = value;
  try { return fn(); } finally {
    if (had === undefined) delete process.env.WRONG_COD_AUTO_REFUND;
    else process.env.WRONG_COD_AUTO_REFUND = had;
  }
}

test('a delivered affected order is refunded without anyone asking, and the customer is told', async () => {
  const row = { ...order, customer_email: 'a@b.com', customer_name: 'Sneha Malik' };
  const db = fakeDbWithRow(row);
  const mails = [];
  const res = await autoRefundOnDelivery({
    supabase: db, orderId: 'uuid-1', source: 'test',
    deps: {
      issueRazorpayRefund: async () => ({ id: 'rfnd_auto' }),
      issuePhonePeRefund: async () => ({}),
      notifyOwnerRefund: async () => ({}),
      sendEmail: async (m) => { mails.push(m); return { ok: true }; },
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.ref, 'rfnd_auto');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'a@b.com');
  assert.match(mails[0].subject, /368\.20/);
  assert.match(mails[0].html, /rfnd_auto/);
});

test('an undelivered order is left alone by the sweep', async () => {
  const db = fakeDbWithRow({ ...order, status: 'shipped' });
  let charged = false;
  const res = await autoRefundOnDelivery({
    supabase: db, orderId: 'uuid-1',
    deps: { issueRazorpayRefund: async () => { charged = true; return { id: 'r' }; }, issuePhonePeRefund: async () => ({}), notifyOwnerRefund: async () => ({}), sendEmail: async () => ({ ok: true }) },
  });
  assert.equal(res.skipped, 'not-delivered');
  assert.equal(charged, false);
});

test('a refund failure never breaks the status write that called it', async () => {
  const db = fakeDbWithRow({ ...order, customer_email: 'a@b.com' });
  const res = await autoRefundOnDelivery({
    supabase: db, orderId: 'uuid-1',
    deps: {
      issueRazorpayRefund: async () => { throw new Error('gateway on fire'); },
      issuePhonePeRefund: async () => ({}), notifyOwnerRefund: async () => ({}),
      sendEmail: async () => { throw new Error('mail on fire too'); },
    },
  });
  assert.equal(res.ok, undefined);
  assert.equal(res.skipped, 'gateway-failed');
});

test('a customer with no email still gets the money, just no note', async () => {
  const db = fakeDbWithRow({ ...order, customer_email: null });
  const mails = [];
  const res = await autoRefundOnDelivery({
    supabase: db, orderId: 'uuid-1',
    deps: { issueRazorpayRefund: async () => ({ id: 'r' }), issuePhonePeRefund: async () => ({}), notifyOwnerRefund: async () => ({}), sendEmail: async (m) => { mails.push(m); return { ok: true }; } },
  });
  assert.equal(res.ok, true);
  assert.equal(mails.length, 0);
});

test('auto-refund can be switched off without touching the code', async () => {
  assert.equal(autoRefundEnabled(undefined), true);
  for (const off of ['0', 'off', 'no', 'FALSE']) assert.equal(autoRefundEnabled(off), false, off);
  await withEnv('0', async () => {
    const db = fakeDbWithRow(order);
    const res = await autoRefundOnDelivery({ supabase: db, orderId: 'uuid-1', deps: { sendEmail: async () => ({ ok: true }) } });
    assert.equal(res.skipped, 'disabled');
  });
});

test('the refund email explains it was our mistake and asks nothing of them', () => {
  const m = refundedEmail({ order: { ...order, customer_name: 'Sneha Malik' }, amountPaise: 36820, ref: 'rfnd_1' });
  assert.match(m.html, /Hi Sneha,/);
  assert.match(m.html, /that was our error|That was our error/);
  assert.match(m.html, /you do not need to do anything/i);
  assert.match(m.html, /368\.20/);
  assert.doesNotMatch(m.html, /UPI ID|bank account/i);
});

test('the attempt counter moves on, so a later refund cannot reuse the same id', async () => {
  const db = fakeDb();
  await performWrongCodRefund({
    supabase: db, order: { ...order, razorpay_payment_id: 'OM2609', refund_attempts: 0 }, source: 'test',
    deps: {
      issueRazorpayRefund: async () => { throw new Error('wrong gateway'); },
      issuePhonePeRefund: async ({ attempt }) => ({ ok: true, merchantRefundId: `REFUND-A${attempt}` }),
      notifyOwnerRefund: async () => ({}),
    },
  });
  const final = db.updates[db.updates.length - 1].patch;
  assert.equal(final.wrong_cod_refund_ref, 'REFUND-A0');
  assert.equal(final.refund_attempts, 1);
});

test('a Razorpay refund leaves the attempt counter alone', async () => {
  const db = fakeDb();
  await performWrongCodRefund({
    supabase: db, order, source: 'test',
    deps: { issueRazorpayRefund: async () => ({ id: 'rfnd_1' }), issuePhonePeRefund: async () => ({}), notifyOwnerRefund: async () => ({}) },
  });
  const final = db.updates[db.updates.length - 1].patch;
  assert.ok(!('refund_attempts' in final));
});

test('the delivery sweep never pays a customer who is on the UPI route', async () => {
  const db = fakeDbWithRow({ ...order, wrong_cod_upi: 'a@okhdfcbank' });
  let charged = false;
  const res = await autoRefundOnDelivery({
    supabase: db, orderId: 'uuid-1',
    deps: { issueRazorpayRefund: async () => { charged = true; return { id: 'r' }; }, issuePhonePeRefund: async () => ({}), notifyOwnerRefund: async () => ({}), sendEmail: async () => ({ ok: true }) },
  });
  assert.equal(res.skipped, 'upi-route');
  assert.equal(charged, false, 'this is exactly the double payment we are preventing');
});
