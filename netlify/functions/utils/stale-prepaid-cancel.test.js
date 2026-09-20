const test = require('node:test');
const assert = require('node:assert');

const { CANCEL_MIN_AGE_DAYS, cancellationAllowed } = require('./cancellation-guard');

const DAY = 24 * 60 * 60 * 1000;
const aged = (days) => ({ created_at: new Date(Date.now() - days * DAY).toISOString() });

// ── The two floors ──────────────────────────────────────────────────────────

test('there is ONE floor for automated cancellation, and it is ten days', () => {
  assert.strictEqual(CANCEL_MIN_AGE_DAYS, 10);
  const g = require('./cancellation-guard');
  assert.ok(!('CANCEL_NO_AWB_MIN_AGE_DAYS' in g), 'the second floor must be gone, not just unused');
  assert.ok(!('CANCEL_NO_AWB_MAX_AGE_DAYS' in g), 'the ceiling must be gone, not just unused');
});

test('an unshipped order is cancelled at ten days and never before', () => {
  assert.strictEqual(cancellationAllowed(aged(9.9)).allowed, false);
  assert.strictEqual(cancellationAllowed(aged(10.01)).allowed, true);
});

test('there is no upper bound — however old, it still gets cancelled', () => {
  for (const d of [11, 93, 400]) {
    assert.strictEqual(cancellationAllowed(aged(d)).allowed, true, `${d}d must still be cancellable`);
  }
});

test('a missing or unparseable created_at is still blocked', () => {
  assert.strictEqual(cancellationAllowed({}).allowed, false);
  assert.strictEqual(cancellationAllowed({ created_at: 'not a date' }).allowed, false);
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
const drainFns = require('../admin-cancel-stale-backlog').__test;

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
  assert.strictEqual(THRESHOLD_DAYS, CANCEL_MIN_AGE_DAYS);
});

test('the sweep and the guard cannot drift apart', () => {
  assert.strictEqual(sweep.__test.THRESHOLD_DAYS, 10);
});

test('the manual drain does NOT inherit the sweep threshold', () => {
  // Tying them together would let a change to the sweep silently widen what
  // the bulk silent-cancel tool reaches.
  assert.notStrictEqual(drainFns.DEFAULT_MIN_AGE_DAYS, sweep.__test.THRESHOLD_DAYS);
  assert.strictEqual(drainFns.DEFAULT_MIN_AGE_DAYS, 30);
});

test('partial COD is swept as prepaid, never as pure COD', () => {
  const { PREPAID_STATUSES } = sweep.__test;
  assert.ok(PREPAID_STATUSES.includes('partial_cod_pending'));
  assert.ok(PREPAID_STATUSES.includes('paid'));
  assert.ok(!PREPAID_STATUSES.includes('cod_pending'));
});


// ── The backlog drain ───────────────────────────────────────────────────────

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
