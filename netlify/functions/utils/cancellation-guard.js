/**
 * Hard guard: an order may not be cancelled by any AUTOMATED path until it is
 * at least CANCEL_MIN_AGE_DAYS old — prepaid or COD, no exceptions.
 *
 * Why this exists
 * ---------------
 * On 24 Aug 2026 NimbusPost reported 71 shipments as "cancelled" in a single
 * 00:45 batch. Every one was under 10 days old (7.61 to 9.99, median 8.74).
 * nimbuspost-webhook.js and nimbuspost-reconcile.js both map a courier
 * "cancelled" straight onto our order status with no age check, and a cancelled
 * PREPAID order then auto-refunds through order-cancelled-notification.js. So a
 * courier-side timeout silently became: order dead, customer told it was
 * cancelled, money sent back — 32 prepaid orders, 27 already at refund_pending
 * and 5 fully refunded before anyone noticed.
 *
 * The courier's own cut-off is NOT 10 days despite the comment in
 * nimbuspost-reconcile.js claiming "~10-day threshold" — the observed data says
 * it fires from 7.6 days. We cannot control when NimbusPost gives up, so the
 * guard lives on our side and simply refuses to act on it too early.
 *
 * Fail closed
 * -----------
 * An order with a missing or unparseable created_at is treated as BLOCKED, not
 * allowed. A guard that protects orders from wrongful cancellation must never
 * let one through because a timestamp was malformed.
 *
 * Scope
 * -----
 * This governs automated cancellation only: courier status sync and the stale
 * COD sweeper. Deliberate human decisions keep their own rules — a customer
 * cancelling in the 30-minute window (cancel-order.js) and an admin cancelling
 * by hand are choices someone made, not a timeout firing on its own.
 */

const CANCEL_MIN_AGE_DAYS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

function orderAgeDays(order, now = Date.now()) {
  const raw = order && order.created_at;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  if (!Number.isFinite(t)) return null;
  return (now - t) / DAY_MS;
}

/**
 * @returns {{allowed: boolean, ageDays: number|null, reason: string}}
 */
function cancellationAllowed(order, { now = Date.now(), minAgeDays = CANCEL_MIN_AGE_DAYS } = {}) {
  const ageDays = orderAgeDays(order, now);
  if (ageDays === null) {
    return { allowed: false, ageDays: null, reason: 'order has no usable created_at — blocked to be safe' };
  }
  if (ageDays < minAgeDays) {
    return {
      allowed: false,
      ageDays,
      reason: `order is ${ageDays.toFixed(2)} days old; automated cancellation is blocked until ${minAgeDays} days`,
    };
  }
  return { allowed: true, ageDays, reason: '' };
}

/** Convenience for call sites that only want the boolean. */
function cancellationBlocked(order, opts) {
  return !cancellationAllowed(order, opts).allowed;
}

module.exports = { CANCEL_MIN_AGE_DAYS, orderAgeDays, cancellationAllowed, cancellationBlocked };
