/**
 * Google Ads conversion adjustments — row selection and CSV shaping.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every order fires a purchase conversion the moment it is placed. COD orders
 * fire before a single rupee has been collected, and ~37% of them are later
 * cancelled or come back RTO. Google Ads never hears about that, so reported
 * conversion value keeps counting revenue that was never realised (₹3.87 L in
 * a 30-day sample) and Smart Bidding optimises toward customers who don't pay.
 *
 * The fix Google supports for this is a conversion ADJUSTMENT: a retraction
 * that removes the original conversion, matched by Order ID. This module picks
 * the orders that need retracting and renders the upload file.
 *
 * MATCHING THE ORIGINAL CONVERSION
 * --------------------------------
 * An adjustment is matched by the Order ID that was sent as `transaction_id`
 * when the conversion fired, so the value here has to be reconstructed exactly
 * as checkout produced it:
 *
 *   Razorpay  -> `response.razorpay_payment_id`, i.e. a `pay_…` string
 *   PhonePe   -> the `IC-…` merchantOrderId (checkout/index.html:1752)
 *   COD       -> the `IC-…` order id (checkout/index.html:1490)
 *
 * Note the deliberate `/^pay_/` test below. The PhonePe payment sweep back-
 * fills `razorpay_payment_id` with PhonePe's own transaction id, but those
 * conversions fired with the `IC-…` id, so only a genuine Razorpay id may
 * override it.
 *
 * GOOGLE'S CONSTRAINTS
 * --------------------
 *   - A conversion older than 55 days can no longer be adjusted.
 *   - The adjustment must be at least 24 hours after the conversion was
 *     recorded, and its timestamp must fall after the conversion time.
 *   - An Order ID Google cannot match is reported in the upload diagnostics
 *     and skipped; it does not corrupt anything. That is what happens to the
 *     rows here whose conversion never actually fired (an abandoned prepaid
 *     attempt, say), so inclusiveness is cheap and under-reporting is not.
 *
 * Retracting is intentionally all-or-nothing. `partially_refunded` would need
 * a RESTATEMENT carrying the surviving value, and we do not store a reliable
 * per-order refunded amount, so those are skipped rather than guessed at.
 */

/** Order states in which the recorded conversion value was never realised. */
const LOSS_STATUSES = new Set([
  'cancelled',
  'cancelled_by_customer',
  'rto',
  'refunded',
  'refund_pending',
  'refund_failed',
]);

/** Rows that are not customer conversions from this storefront. */
const EXCLUDED_SOURCES = new Set(['replacement', 'paperbound']);

/**
 * Order-id prefixes that never reached the checkout success screen, so no
 * conversion was ever fired for them: `IC-W-` is a WhatsApp bot order
 * (whatsapp-bot.js) and `IC-R-` is an admin-created replacement. `IC-CW-`
 * (Crossword-migrated carts) IS a real storefront checkout and stays in.
 */
const NON_CONVERTING_PREFIX = /^IC-(?:W|R)-/i;

const MAX_CONVERSION_AGE_DAYS = 54;   // Google's limit is 55; stay inside it.
const MIN_ADJUSTMENT_AGE_HOURS = 24;  // Google's minimum gap after the conversion.

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The `transaction_id` this order's conversion was fired with, or null when
 * the order can never be matched.
 */
function conversionOrderId(order) {
  const pay = String(order.razorpay_payment_id || '').trim();
  if (/^pay_/.test(pay)) return pay;
  const id = String(order.razorpay_order_id || '').trim();
  return id || null;
}

/**
 * When the loss was recorded. Falls back to `now` — Google only requires that
 * the adjustment happened after the conversion, and "we found out about it on
 * this run" is truthful, where inventing a date would not be.
 */
function adjustmentTimeFor(order, now) {
  const candidate = order.cancelled_at
    || order.auto_cancelled_at
    || order.refund_updated_at
    || order.shipment_moved_at
    || order.last_nimbuspost_event_at;
  const parsed = candidate ? new Date(candidate) : null;
  const t = parsed && !Number.isNaN(parsed.getTime()) ? parsed.getTime() : now.getTime();
  // Never before the conversion, never in the future.
  const created = new Date(order.created_at).getTime();
  const floor = Number.isNaN(created) ? t : created + HOUR_MS;
  return new Date(Math.min(Math.max(t, floor), now.getTime()));
}

/** `2026-06-22 08:02:17+05:30` — self-describing, so no Parameters row is needed. */
function istStamp(date) {
  const shifted = new Date(date.getTime() + 5.5 * HOUR_MS).toISOString();
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 19)}+05:30`;
}

/**
 * Pick the orders to retract.
 *
 * @returns {{rows: Array, skipped: Object}} rows are `{orderId, adjustmentTime,
 *   status, amount, createdAt}`; `skipped` counts why the rest were dropped.
 */
function buildAdjustmentRows(orders, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const maxAgeDays = Number(options.maxAgeDays) || MAX_CONVERSION_AGE_DAYS;
  const minAgeHours = Number.isFinite(options.minAgeHours)
    ? Number(options.minAgeHours)
    : MIN_ADJUSTMENT_AGE_HOURS;

  const oldest = now.getTime() - maxAgeDays * DAY_MS;
  const newest = now.getTime() - minAgeHours * HOUR_MS;

  const skipped = {
    status: 0, source: 0, never_converted: 0,
    too_old: 0, too_recent: 0, no_order_id: 0, duplicate: 0,
  };
  const seen = new Set();
  const rows = [];

  for (const order of orders || []) {
    if (!LOSS_STATUSES.has(String(order.status || ''))) { skipped.status++; continue; }
    if (EXCLUDED_SOURCES.has(String(order.source || ''))) { skipped.source++; continue; }
    if (NON_CONVERTING_PREFIX.test(String(order.razorpay_order_id || ''))) {
      skipped.never_converted++; continue;
    }

    const created = new Date(order.created_at).getTime();
    if (!Number.isFinite(created) || created < oldest) { skipped.too_old++; continue; }
    if (created > newest) { skipped.too_recent++; continue; }

    const orderId = conversionOrderId(order);
    if (!orderId) { skipped.no_order_id++; continue; }
    if (seen.has(orderId)) { skipped.duplicate++; continue; }
    seen.add(orderId);

    rows.push({
      orderId,
      adjustmentTime: adjustmentTimeFor(order, now),
      status: order.status,
      amount: Math.round(Number(order.amount_paise || 0)) / 100,
      createdAt: order.created_at,
    });
  }

  rows.sort((a, b) => a.adjustmentTime - b.adjustmentTime);
  return { rows, skipped };
}

function csvCell(value) {
  const s = String(value == null ? '' : value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Render Google's conversion-adjustment upload format.
 * `conversionName` must be the conversion action's name in the destination
 * account, spelled exactly as it appears there.
 */
function toCsv(rows, conversionName) {
  const lines = ['Order ID,Conversion Name,Adjustment Time,Adjustment Type'];
  for (const row of rows) {
    lines.push([
      csvCell(row.orderId),
      csvCell(conversionName),
      csvCell(istStamp(row.adjustmentTime)),
      'RETRACTION',
    ].join(','));
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  LOSS_STATUSES,
  EXCLUDED_SOURCES,
  NON_CONVERTING_PREFIX,
  MAX_CONVERSION_AGE_DAYS,
  MIN_ADJUSTMENT_AGE_HOURS,
  conversionOrderId,
  adjustmentTimeFor,
  istStamp,
  buildAdjustmentRows,
  toCsv,
};
