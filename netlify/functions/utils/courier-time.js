/**
 * Parse a NimbusPost timestamp correctly, whatever timezone the server is in.
 *
 * The problem
 * -----------
 * NimbusPost sends naive local times with no zone marker:
 *
 *     "event_time": "2021-02-26 16:19:59"
 *
 * Those are IST. `new Date(raw)` interprets a zone-less string as the SERVER's
 * local time, so the result depends entirely on where the code runs:
 *
 *     TZ=UTC  (Netlify)  -> 16:19:59Z   ... 5.5 hours too late
 *     TZ=IST  (a laptop) -> 10:49:59Z   ... correct, by luck
 *
 * Production runs on UTC, so every courier event was stored 5.5 hours in the
 * future. Measured over 3,395 delivered orders, the gap between the courier's
 * event time and our own delivered_at (written by our clock in the same call)
 * had a median of 5.39h with p90 at 5.50h, and 210 orders carried event times
 * dated in the future — up to 5.46h ahead of now, which is impossible.
 *
 * Anything keyed on last_nimbuspost_event_at inherits the error: admin date
 * filters, "cancelled by courier" views, and any age arithmetic done against it.
 *
 * The rule
 * --------
 * If the string carries an explicit zone (trailing Z, or ±HH:MM), trust it —
 * NimbusPost may start sending proper ISO timestamps, and this must not
 * double-shift those. Only a zone-less string is assumed IST.
 *
 * Note the deliberate absence of a local-time fallback: reading the host's
 * timezone is exactly what caused this, so the offset is hard-coded.
 */

const IST_OFFSET = '+05:30';

// Explicit zone: trailing Z/z, or ±HH:MM / ±HHMM / ±HH at the very end.
const HAS_ZONE = /(?:[Zz]|[+-]\d{2}:?\d{2}|[+-]\d{2})$/;
// "YYYY-MM-DD HH:MM(:SS)" with a space or T separator, and nothing else.
const NAIVE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/;

/**
 * @param {string|number|Date} raw
 * @returns {Date|null} null when unparseable
 */
function parseCourierTime(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Date) return Number.isFinite(raw.getTime()) ? raw : null;

  // Epoch numbers are unambiguous.
  if (typeof raw === 'number') {
    const d = new Date(raw < 1e12 ? raw * 1000 : raw);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  const s = String(raw).trim();
  if (!s) return null;

  const naive = s.match(NAIVE);
  if (naive && !HAS_ZONE.test(s)) {
    const d = new Date(`${naive[1]}T${naive[2]}${IST_OFFSET}`);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * ISO string for storage. Falls back to now when the courier sends nothing
 * usable — the previous behaviour, and better than a null timestamp.
 */
function courierTimeToIso(raw, { fallbackToNow = true } = {}) {
  const d = parseCourierTime(raw);
  if (d) return d.toISOString();
  return fallbackToNow ? new Date().toISOString() : null;
}

module.exports = { parseCourierTime, courierTimeToIso, IST_OFFSET };
