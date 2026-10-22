'use strict';

/**
 * What one live courier answer changes on an order, for the bookings that send
 * us no scans (Amazon Shipping and Delhivery through iThink, DTDC / Ekart /
 * Bluedart through NimbusPost). XpressBees has its own poller.
 *
 * Why: those orders froze at `shipped`. IC-20260919-IUPN2 was delivered by
 * Amazon on 24 Sep and still read "shipped" weeks later, so the customer could
 * not report her damaged book (that needs `delivered`), and the Cancel button
 * stayed open until it was used.
 *
 * Same rules as utils/xpressbees-status.js, and the same mapping:
 *   - only delivered and out_for_delivery move `status`, and only forward
 *   - in transit advances shipment_moved_at, never `status`
 *   - RTO, exceptions and courier cancellations are recorded as text only;
 *     money paths stay with the jobs that ask the courier themselves
 *   - delivered_at is the courier's own scan time when it gives one
 */

const { interpret, SYNCABLE, TERMINAL, RANK } = require('./xpressbees-status');

const MOVES_STATUS = new Set(['delivered', 'out_for_delivery']);
const RECENT_MS = 10 * 86400000;

/**
 * @param {object} order  id, status, shipment_moved_at, delivered_at
 * @param {object|undefined} live  checkPickups() entry: { status, state, at? }
 * @param {string} now  ISO
 * @returns {{ fields: object, to: string|null }}
 */
function planUpdate(order, live, now) {
  // Unknown still gets stamped, so the rotation moves on to other orders.
  if (!live || live.state === 'unknown' || !String(live.status || '').trim()) {
    return { fields: { last_courier_status_at: now }, to: null };
  }
  const raw = String(live.status).trim();
  const fields = { last_courier_status: raw.slice(0, 200), last_courier_status_at: now };
  if (live.state === 'moved') fields.shipment_moved_at = order.shipment_moved_at || now;

  const from = String(order.status || '').toLowerCase();
  const target = interpret(raw).status;
  const forward = target && MOVES_STATUS.has(target)
    && SYNCABLE.includes(from) && !TERMINAL.includes(from)
    && !(RANK[target] <= RANK[from]);
  if (!forward) return { fields, to: null };

  fields.status = target;
  if (target === 'delivered') {
    // The courier's scan time. Without one, "now" is only a fair guess for a
    // recent parcel: an August parcel stamped today would be asked for a review
    // and get a fresh replacement window. Those stay blank (the replacement
    // form sends a blank-date order to support).
    const at = live.at && Date.parse(live.at) <= Date.parse(now) ? live.at : null;
    const recent = order.shipped_at && Date.parse(now) - Date.parse(order.shipped_at) <= RECENT_MS;
    const when = order.delivered_at || at || (recent ? now : null);
    if (when) fields.delivered_at = when;
    fields.shipment_moved_at = order.shipment_moved_at || when || now;
  }
  return { fields, to: target };
}

module.exports = { planUpdate, MOVES_STATUS };
