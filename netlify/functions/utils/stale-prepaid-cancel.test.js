const test = require('node:test');
const assert = require('node:assert');

const {
  CANCEL_MIN_AGE_DAYS,
  CANCEL_NO_AWB_MIN_AGE_DAYS,
  CANCEL_NO_AWB_MAX_AGE_DAYS,
  cancellationAllowed,
} = require('./cancellation-guard');

const DAY = 24 * 60 * 60 * 1000;
const aged = (days) => ({ created_at: new Date(Date.now() - days * DAY).toISOString() });

// ── The two floors ──────────────────────────────────────────────────────────

test('the no-AWB floor is seven days and the courier floor stays at ten', () => {
  assert.strictEqual(CANCEL_NO_AWB_MIN_AGE_DAYS, 7);
  assert.strictEqual(CANCEL_MIN_AGE_DAYS, 10);
});

test('an 8-day order passes the no-AWB floor but not the courier floor', () => {
  const order = aged(8);
  assert.strictEqual(cancellationAllowed(order, { minAgeDays: CANCEL_NO_AWB_MIN_AGE_DAYS }).allowed, true);
  assert.strictEqual(cancellationAllowed(order).allowed, false);
});

test('a 6-day order is blocked by both', () => {
  const order = aged(6);
  assert.strictEqual(cancellationAllowed(order, { minAgeDays: CANCEL_NO_AWB_MIN_AGE_DAYS }).allowed, false);
  assert.strictEqual(cancellationAllowed(order).allowed, false);
});

test('exactly seven days is old enough for the no-AWB sweep', () => {
  assert.strictEqual(
    cancellationAllowed(aged(7.001), { minAgeDays: CANCEL_NO_AWB_MIN_AGE_DAYS }).allowed, true);
});

test('a missing created_at is still blocked, shorter floor or not', () => {
  assert.strictEqual(cancellationAllowed({}, { minAgeDays: CANCEL_NO_AWB_MIN_AGE_DAYS }).allowed, false);
  assert.strictEqual(
    cancellationAllowed({ created_at: 'not a date' }, { minAgeDays: CANCEL_NO_AWB_MIN_AGE_DAYS }).allowed, false);
});

// ── The email may not claim a refund that has not happened ──────────────────

const { orderCancelledEmailHtml } = require('./order-cancelled-notification').__test;

const paidOrder = {
  razorpay_order_id: 'IC-20260913-GV1XC',
  razorpay_payment_id: 'pay_abc123',
  amount_paise: 23900,
  customer_name: 'Kazi Nasim Zaman',
  cart_items: [{ title: 'Atomic Habits', qty: 1 }],
};

test('the email claims "refunded" only when the gateway confirmed it', () => {
  const html = orderCancelledEmailHtml(paidOrder, { ok: true, nextStatus: 'refunded' }, {});
  assert.match(html, /refunded<\/p>/);
  assert.match(html, /has been issued/);
});

test('a PENDING refund never prints the refunded headline', () => {
  const html = orderCancelledEmailHtml(paidOrder, { ok: true, nextStatus: 'refund_pending' }, {});
  assert.doesNotMatch(html, /refunded<\/p>/);
  assert.match(html, /is being processed/);
});

test('a FAILED refund never prints the refunded headline', () => {
  const html = orderCancelledEmailHtml(paidOrder, { ok: false, error: 'gateway down' }, {});
  assert.doesNotMatch(html, /refunded<\/p>/);
  assert.match(html, /is being processed/);
});

test('a COD cancellation says plainly that nothing was charged', () => {
  const cod = { ...paidOrder, razorpay_payment_id: null };
  const html = orderCancelledEmailHtml(cod, undefined, { skipRefund: true });
  assert.doesNotMatch(html, /refunded<\/p>/);
  assert.match(html, /not charged/);
});

// ── The sweep's own wiring ──────────────────────────────────────────────────

const sweep = require('../auto-cancel-stale-cod');

test('the prepaid sweep is on by default and killable by env', () => {
  const { prepaidSweepEnabled } = sweep.__test;
  assert.strictEqual(prepaidSweepEnabled(undefined), true);
  assert.strictEqual(prepaidSweepEnabled(''), true);
  assert.strictEqual(prepaidSweepEnabled('1'), true);
  for (const off of ['0', 'off', 'false', 'no', 'OFF', 'False']) {
    assert.strictEqual(prepaidSweepEnabled(off), false, `${off} should disable the sweep`);
  }
});

test('the refund cap is far below the cancellation cap', () => {
  const { MAX_REFUNDS_PER_RUN, MAX_PER_RUN, THRESHOLD_DAYS } = sweep.__test;
  assert.ok(MAX_REFUNDS_PER_RUN < MAX_PER_RUN);
  assert.strictEqual(THRESHOLD_DAYS, 7);
});

test('partial COD is swept as prepaid, never as pure COD', () => {
  const { PREPAID_STATUSES } = sweep.__test;
  assert.ok(PREPAID_STATUSES.includes('partial_cod_pending'));
  assert.ok(PREPAID_STATUSES.includes('paid'));
  assert.ok(!PREPAID_STATUSES.includes('cod_pending'));
});


// ── The ceiling ─────────────────────────────────────────────────────────────

const CEIL = { minAgeDays: CANCEL_NO_AWB_MIN_AGE_DAYS, maxAgeDays: CANCEL_NO_AWB_MAX_AGE_DAYS };

test('the ceiling is ten days', () => {
  assert.strictEqual(CANCEL_NO_AWB_MAX_AGE_DAYS, 10);
});

test('an order inside the 7-10 day window is swept', () => {
  for (const d of [7.01, 8, 9.9]) {
    assert.strictEqual(cancellationAllowed(aged(d), CEIL).allowed, true, `${d}d should be swept`);
  }
});

test('an order past the ceiling is refused, and says so distinctly', () => {
  const v = cancellationAllowed(aged(93), CEIL);
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.tooOld, true);
  assert.match(v.reason, /ceiling/);
});

test('"not yet" and "not any more" are tellable apart', () => {
  const young = cancellationAllowed(aged(3), CEIL);
  const old = cancellationAllowed(aged(40), CEIL);
  assert.strictEqual(young.allowed, false);
  assert.ok(!young.tooOld, 'a young order must not be reported as too old');
  assert.strictEqual(old.tooOld, true);
});

test('with no ceiling passed, nothing is ever too old (existing callers unchanged)', () => {
  const v = cancellationAllowed(aged(400));
  assert.strictEqual(v.allowed, true);
  assert.ok(!v.tooOld);
});

test('the sweep applies both bounds', () => {
  const { THRESHOLD_DAYS, CEILING_DAYS } = sweep.__test;
  assert.strictEqual(THRESHOLD_DAYS, 7);
  assert.strictEqual(CEILING_DAYS, 10);
});

// ── The backlog drain ───────────────────────────────────────────────────────

const drainFns = require('../admin-cancel-stale-backlog').__test;

test('the drain only ever looks at COD statuses', () => {
  assert.deepStrictEqual(drainFns.COD_STATUSES, ['cod_pending', 'cod_awaiting_confirmation']);
  assert.ok(!drainFns.COD_STATUSES.includes('paid'));
  assert.ok(!drainFns.COD_STATUSES.includes('partial_cod_pending'));
});

test('the drain tells the customer nothing was taken, because nothing was', () => {
  assert.match(drainFns.CANCEL_REASON, /No payment was taken/);
});

test('the drain skips anything with money on it rather than closing it', async () => {
  const rows = [
    { id: '1', razorpay_order_id: 'IC-A', status: 'cod_pending', amount_paise: 25900,
      created_at: new Date(Date.now() - 90 * 864e5).toISOString(), razorpay_payment_id: null },
    { id: '2', razorpay_order_id: 'IC-B', status: 'cod_pending', amount_paise: 13900,
      created_at: new Date(Date.now() - 90 * 864e5).toISOString(), razorpay_payment_id: 'pay_x' },
  ];
  const q = { _r: rows };
  for (const m of ['select', 'or', 'in', 'is', 'lt', 'order']) q[m] = () => q;
  q.limit = () => Promise.resolve({ data: q._r, error: null });
  const supabase = { from: () => q };

  const out = await drainFns.drain(supabase, { dryRun: true });
  assert.strictEqual(out.candidates, 2);
  assert.strictEqual(out.skipped_has_payment, 1);
  assert.strictEqual(out.orders.length, 1);
  assert.strictEqual(out.orders[0].order_id, 'IC-A');
  assert.strictEqual(out.needs_a_refund_decision[0].order_id, 'IC-B');
});

test('a dry run writes nothing', async () => {
  let updates = 0;
  const rows = [{ id: '1', razorpay_order_id: 'IC-A', status: 'cod_pending', amount_paise: 25900,
    created_at: new Date(Date.now() - 90 * 864e5).toISOString(), razorpay_payment_id: null }];
  const q = { _r: rows };
  for (const m of ['select', 'or', 'in', 'is', 'lt', 'order']) q[m] = () => q;
  q.limit = () => Promise.resolve({ data: q._r, error: null });
  q.update = () => { updates++; return q; };
  const supabase = { from: () => q };

  const out = await drainFns.drain(supabase, { dryRun: true });
  assert.strictEqual(updates, 0);
  assert.strictEqual(out.cancelled, 0);
  assert.strictEqual(out.candidates, 1);
});
