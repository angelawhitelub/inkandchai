/**
 * Is a six-digit number a real pincode, or a flat / house / order number?
 *
 * Customers write "flat no 260187" and "5-100832" into the street line, and a
 * parser looking for six digits cannot tell those from a pincode. A directory
 * can: IC-20260811-RQIL6 went out to 260187 (no such pincode) instead of the
 * 201009 in its pincode field.
 *
 * "Known" means India Post's directory OR Delhivery's serviceability list.
 * Neither is complete alone: the India Post export lacks ~2,100 codes that
 * Delhivery delivers to (newer and non-delivery-office codes). A code in
 * either is treated as real. Refresh with scripts/build-india-pincodes.js.
 */

const INDIA_POST = require('../../../data/india-pincodes.generated.js');
const DELHIVERY = require('../../../data/delhivery-pincodes.generated.js');

const WIDTH = 6;

// Built once per isolate, on the first question asked.
let _set = null;
function pinSet() {
  if (_set) return _set;
  _set = new Set();
  for (const s of [INDIA_POST.pins, DELHIVERY.pins]) {
    for (let i = 0; i < s.length; i += WIDTH) _set.add(s.slice(i, i + WIDTH));
  }
  return _set;
}

/** Is this a pincode some directory knows? Unreadable input is not. */
function isKnownPincode(pin) {
  const p = String(pin == null ? '' : pin).trim();
  return /^[1-8]\d{5}$/.test(p) && pinSet().has(p);
}

module.exports = {
  isKnownPincode,
  count: INDIA_POST.count,
  generatedAt: INDIA_POST.generatedAt,
};
