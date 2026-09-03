'use strict';

/**
 * Turning NimbusPost serviceability into a date we are willing to print on a
 * product page.
 *
 * The page used to show a fixed table — Delhi NCR +1, "Nearby states" +2,
 * "Rest of India" +3 — which is a guess dressed as a promise. NimbusPost
 * returns a real per-courier EDD for the exact destination pincode, so a
 * customer can be told a date that the courier actually stands behind.
 *
 * Everything here is pure so it can be tested without touching the network.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// The nightly courier manifest closes at 03:00 IST. An order placed before it
// still makes that morning's dispatch; from 03:00 it waits for the next one.
// Same rule the old badge used — customers should not see the dispatch date
// move just because the estimate got smarter.
const SHIP_CUTOFF_HOUR_IST = 3;

/** A Date whose UTC getters read as IST wall-clock values. */
function istNow(now = Date.now()) {
  return new Date(now + IST_OFFSET_MS);
}

/** 'YYYY-MM-DD' for a date already shifted into IST. */
function isoDay(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

/**
 * The day we hand the parcel to the courier.
 * @param {number} now epoch ms
 * @param {number} extraDays for limited-stock titles that need longer to pick
 */
function shipByDate(now = Date.now(), extraDays = 0) {
  const ist = istNow(now);
  const daysToShip = (ist.getUTCHours() < SHIP_CUTOFF_HOUR_IST ? 0 : 1) + Math.max(0, extraDays);
  return addDays(ist, daysToShip);
}

/**
 * NimbusPost sends EDD as 'DD-MM-YYYY'. Returns a Date at UTC midnight, or
 * null for anything that is not that exact shape — a silently misparsed date
 * would be printed to a customer as a delivery promise.
 */
function parseEdd(value) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(value || '').trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  // Reject 31-02-2026 and friends: Date rolls them over silently.
  if (d.getUTCDate() !== Number(dd) || d.getUTCMonth() !== Number(mm) - 1) return null;
  return d;
}

/**
 * The date to show, from the couriers NimbusPost offered.
 *
 * The EARLIEST EDD is deliberately not used: it is whichever courier is most
 * optimistic, and we do not get to choose that courier at ship time. The
 * median is what a typical booking actually gets, and it is the number we can
 * stand behind when a customer holds us to it.
 *
 * Never earlier than the day after dispatch — a courier EDD that predates our
 * own manifest is not a delivery date, it is a data error.
 */
function pickEdd(couriers, shipBy) {
  const days = (couriers || [])
    .map(c => parseEdd(c && c.edd))
    .filter(Boolean)
    .map(d => d.getTime())
    .sort((a, b) => a - b);
  if (!days.length) return null;

  const median = days[Math.floor(days.length / 2)];
  const floor = addDays(new Date(Date.UTC(
    shipBy.getUTCFullYear(), shipBy.getUTCMonth(), shipBy.getUTCDate())), 1).getTime();
  return new Date(Math.max(median, floor));
}

/**
 * How long this answer may be cached.
 *
 * An EDD is a calendar date, so a copy cached across midnight IST is wrong by
 * a whole day. Expire just after the IST date rolls over, and never hold one
 * longer than six hours even early in the day.
 */
function cacheSeconds(now = Date.now(), maxSeconds = 21600) {
  const ist = istNow(now);
  const endOfDay = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1, 0, 30);
  const untilRollover = Math.floor((endOfDay - ist.getTime()) / 1000);
  return Math.max(60, Math.min(maxSeconds, untilRollover));
}

module.exports = {
  istNow, isoDay, addDays, shipByDate, parseEdd, pickEdd, cacheSeconds,
  SHIP_CUTOFF_HOUR_IST,
};
