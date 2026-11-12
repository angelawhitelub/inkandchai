'use strict';

/**
 * Owner, 12 Nov 2026: "let them know that orders are not being picked up due
 * to Diwali holidays and that it will be picked up either today or tomorrow
 * morning." The WhatsApp bot tells this to a customer whose order is booked
 * but not yet picked up, before it offers to cancel.
 *
 * Time-boxed on purpose: "today or tomorrow morning" turns false in a day or
 * two, so the notice stops by itself after PICKUP_DELAY_UNTIL (a 'YYYY-MM-DD'
 * IST date, inclusive; wrangler.toml [vars]). PICKUP_DELAY_NOTICE overrides
 * the wording. Clearing PICKUP_DELAY_UNTIL turns it off.
 */

const DEFAULT_UNTIL = '2026-11-13';
const DEFAULT_TEXT = 'Courier pickups were paused for the Diwali holidays, so your parcel has not been collected yet. It will be picked up today or by tomorrow morning.';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The notice text while it is in force, else ''. */
function pickupDelayNotice(now = Date.now(), env = process.env) {
  const until = String(env.PICKUP_DELAY_UNTIL ?? DEFAULT_UNTIL).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return '';
  const todayIst = new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);
  if (todayIst > until) return '';
  return String(env.PICKUP_DELAY_NOTICE || DEFAULT_TEXT).trim();
}

module.exports = { pickupDelayNotice, DEFAULT_UNTIL, DEFAULT_TEXT };
