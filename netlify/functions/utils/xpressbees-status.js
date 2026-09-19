'use strict';

/**
 * One reading of what XpressBees just said about a parcel.
 *
 * Two things consume this: the webhook (xpressbees-webhook.js), which is the
 * live path, and the poller (xpressbees-status-sync-background.js), which is
 * the backstop for anything the webhook misses or that was shipped before the
 * webhook existed. They MUST agree -- two mappings would mean an order's
 * status depended on which one happened to see the scan first -- so the
 * mapping lives here and neither of them keeps a copy.
 *
 * The rules it encodes, each one a test in utils/xpressbees-status.test.js:
 *
 *   - `cancelled` NEVER cancels the order. Cancelling a stale panel row is
 *     our own housekeeping -- 51 were cancelled on 19 Sep for orders that had
 *     already shipped through iThink -- and mapping that back onto `status`
 *     would have cancelled 51 live shipments.
 *   - RTO sets `status` and nothing else. A returned parcel is not a refund
 *     and no money path may key off a courier scan.
 *   - `in transit` never touches `status`. Hub scans repeat endlessly and
 *     admin filters and revenue must not move with them; only the movement
 *     stamp advances.
 *   - An exception is flagged for a human, not written as a status: we have
 *     no such order state and it must not read as the customer's fault.
 *   - Anything unrecognised is recorded, never guessed at.
 */

/**
 * XpressBees status text -> what we do about it.
 *
 *   status  : the order status to move to
 *   moved   : the parcel has physically moved (advance shipment_moved_at)
 *   record  : recognised, but status is not ours to change from here
 */
function interpret(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return { record: true };
  if (/^delivered$|delivered to|shipment delivered/.test(s)) return { status: 'delivered', moved: true };
  if (/out for delivery|^ofd$/.test(s))                      return { status: 'out_for_delivery', moved: true };
  // RTO in every spelling, including the delivered-back one: the parcel is
  // coming home, which is a shipping fact and never a money one.
  if (/^rto|rto|return to origin|returning/.test(s))         return { status: 'rto', moved: true };
  if (/transit|bagged|received at|reached|dispatch|picked|pickup done|out scan|in scan/.test(s))
    return { moved: true, record: true };
  if (/pending pickup|booked|manifest|awaiting|data received/.test(s)) return { record: true };
  // Exception / NDR: real, but we have no such order status and it must not
  // look like a delivery failure the customer caused. Recorded for the owner.
  if (/exception|undelivered|ndr|failed/.test(s))            return { record: true, attention: true };
  // "cancelled" lands here deliberately -- see WHAT IT REFUSES TO DO (1).
  return { record: true };
}

// Statuses a courier scan may move an order OUT of. Everything else is either
// finished or owned by the money side of the system.
const SYNCABLE = ['shipped', 'out_for_delivery'];
const REFUND_STATES = ['refunded', 'partially_refunded', 'refund_pending', 'refund_failed'];
const TERMINAL = ['delivered', 'cancelled', 'rto', 'rto_delivered', 'lost', ...REFUND_STATES];

// Same ordering the NimbusPost webhook uses, so every courier path agrees
// about what counts as forward. Absent = rank 0 = decided by explicit guards.
const RANK = { shipped: 1, out_for_delivery: 2, delivered: 3 };

module.exports = { interpret, SYNCABLE, REFUND_STATES, TERMINAL, RANK };
