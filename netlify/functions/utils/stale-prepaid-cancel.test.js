const test = require('node:test');
const assert = require('node:assert');

const {
  CANCEL_MIN_AGE_DAYS,
  CANCEL_NO_AWB_MIN_AGE_DAYS,
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
