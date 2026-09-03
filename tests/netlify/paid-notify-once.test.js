'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { claimPaidNotify, PRE_PAYMENT_STATUSES } =
  require('../../netlify/functions/utils/paid-notify-once');

/**
 * A stand-in for one order row, enforcing the two things that matter:
 * `.is(col, null)` only matches while the stamp is unset, and
 * `.in('status', …)` only matches while the row is still pre-payment.
 */
function fakeDb({ hasStampColumn = true, status = 'pending_phonepe', stamp = null, hardError = null } = {}) {
  const row = { id: 'o1', status, paid_notified_at: stamp };
  const calls = [];
  return {
    row, calls,
    from() {
      let pending, conds = {};
      const q = {
        update(fields) { pending = fields; return q; },
        eq() { return q; },
        is(col, val) { conds.is = [col, val]; return q; },
        in(col, vals) { conds.in = [col, vals]; return q; },
        async select() {
          calls.push({ fields: pending, conds });
          if (hardError) return { data: null, error: { message: hardError } };
          if ('paid_notified_at' in pending && !hasStampColumn) {
            return { data: null, error: { message: 'column orders.paid_notified_at does not exist' } };
          }
          if (conds.is && row[conds.is[0]] !== conds.is[1]) return { data: [], error: null };
          if (conds.in && !conds.in[1].includes(row[conds.in[0]])) return { data: [], error: null };
          Object.assign(row, pending);
          return { data: [{ id: row.id }], error: null };
        },
      };
      return q;
    },
  };
}

test('the first caller wins and the second stays quiet', async () => {
  const db = fakeDb();
  const a = await claimPaidNotify(db, 'o1', 'paid');
  const b = await claimPaidNotify(db, 'o1', 'paid');
  assert.deepStrictEqual([a.won, a.via], [true, 'stamp']);
  assert.strictEqual(b.won, false, 'the second caller must not notify');
  assert.ok(db.row.paid_notified_at, 'the stamp is set');
});

test('the claim does not care which path runs first', async () => {
  // Webhook first, then the returning browser — and the reverse. Same outcome.
  for (const order of [['webhook', 'verify'], ['verify', 'webhook']]) {
    const db = fakeDb();
    const results = [];
    for (const who of order) results.push([who, (await claimPaidNotify(db, 'o1', 'paid')).won]);
    assert.deepStrictEqual(results.map(r => r[1]), [true, false], order.join(' then '));
  }
});

test('an already-notified order is never notified again', async () => {
  const db = fakeDb({ stamp: '2026-09-03T00:00:00Z' });
  const r = await claimPaidNotify(db, 'o1', 'paid');
  assert.strictEqual(r.won, false);
});

test('without the column it falls back to claiming the status transition', async () => {
  const db = fakeDb({ hasStampColumn: false, status: 'pending_phonepe' });
  const a = await claimPaidNotify(db, 'o1', 'paid');
  assert.deepStrictEqual([a.won, a.via], [true, 'status']);
  assert.strictEqual(db.row.status, 'paid');
  // The row is no longer pre-payment, so the second caller loses.
  const b = await claimPaidNotify(db, 'o1', 'paid');
  assert.strictEqual(b.won, false);
});

test('the fallback refuses an order that is already past pre-payment', async () => {
  const db = fakeDb({ hasStampColumn: false, status: 'paid' });
  assert.strictEqual((await claimPaidNotify(db, 'o1', 'paid')).won, false);
  const shipped = fakeDb({ hasStampColumn: false, status: 'shipped' });
  assert.strictEqual((await claimPaidNotify(shipped, 'o1', 'paid')).won, false);
});

test('partial COD bookings claim on their own pre-payment status', async () => {
  assert.deepStrictEqual(PRE_PAYMENT_STATUSES, ['pending_phonepe', 'pending_partial_phonepe']);
  const db = fakeDb({ hasStampColumn: false, status: 'pending_partial_phonepe' });
  const r = await claimPaidNotify(db, 'o1', 'partial_cod_pending');
  assert.strictEqual(r.won, true);
  assert.strictEqual(db.row.status, 'partial_cod_pending');
});

test('a real database error never grants the claim', async () => {
  // Silence beats a storm of duplicate emails when the database is unhappy.
  const db = fakeDb({ hardError: 'permission denied for table orders' });
  const r = await claimPaidNotify(db, 'o1', 'paid');
  assert.strictEqual(r.won, false);
  assert.strictEqual(r.via, 'error');
  assert.match(r.error, /permission denied/);
});

test('missing arguments never grant the claim', async () => {
  assert.strictEqual((await claimPaidNotify(null, 'o1', 'paid')).won, false);
  assert.strictEqual((await claimPaidNotify(fakeDb(), '', 'paid')).won, false);
});

test('with no column and no target status, nobody is granted the claim', async () => {
  const db = fakeDb({ hasStampColumn: false });
  const r = await claimPaidNotify(db, 'o1', null);
  assert.deepStrictEqual([r.won, r.via], [false, 'no-column']);
});
