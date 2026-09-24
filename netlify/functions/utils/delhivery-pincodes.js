/**
 * Is a pincode one Delhivery actually delivers to?
 *
 * Delhivery's API only answers this at booking time, by refusing the shipment
 * -- which costs a round trip, leaves the order in a half-pushed state and,
 * on a bulk run, buries the reason in a batch response. Their published
 * serviceability export answers it for free, before anything is sent.
 *
 * THE LIST IS A WHITELIST. A pincode absent from the export is one Delhivery
 * does not serve, which is exactly the question this module exists to answer.
 * Refreshed by scripts/build-delhivery-pincodes.js; see it for the format.
 *
 * CAUTION: this is only reliable in one direction. ABSENT means Delhivery
 * does not serve it. PRESENT does not guarantee a booking: on 25 Sep their API
 * refused 683585, 795001 and 389155 as "non serviceable pincode" although the
 * export lists all three as fully serviceable. Weight limits, embargoes and a
 * flat wallet are further reasons for a refusal. So this narrows the guesswork
 * -- it does not replace reading what Delhivery says when a booking fails.
 */

const DATA = require('../../../data/delhivery-pincodes.generated.js');

const WIDTH = 6;

/** Six digits, or ''. Indian pincodes never start with 0 or 9. */
function normalizePin(value) {
  const digits = String(value == null ? '' : value).replace(/\D/g, '');
  return /^[1-8]\d{5}$/.test(digits) ? digits : '';
}

// Built once per isolate, on the first question asked. A Set of 18,699 short
// strings is cheap; parsing them on every cold start would not be.
let _set = null;
function pinSet() {
  if (_set) return _set;
  _set = new Set();
  const s = DATA.pins;
  for (let i = 0; i < s.length; i += WIDTH) _set.add(s.slice(i, i + WIDTH));
  return _set;
}

let _except = null;
function exceptions() {
  if (_except) return _except;
  _except = {
    noCod: new Set(DATA.noCod || []),
    noReverse: new Set(DATA.noReverse || []),
    noReplacement: new Set(DATA.noReplacement || []),
    noCash: new Set(DATA.noCash || []),
  };
  return _except;
}

/** Does Delhivery deliver here at all? An unreadable pincode is NOT serviceable. */
function isServiceable(pin) {
  const p = normalizePin(pin);
  return p ? pinSet().has(p) : false;
}

/** Can they collect cash on delivery here? False everywhere they do not deliver. */
function codServiceable(pin) {
  const p = normalizePin(pin);
  if (!p || !pinSet().has(p)) return false;
  return !exceptions().noCod.has(p);
}

/** Can they pick a parcel back up here (returns)? */
function reversePickupServiceable(pin) {
  const p = normalizePin(pin);
  if (!p || !pinSet().has(p)) return false;
  return !exceptions().noReverse.has(p);
}

/** Can they run a replacement (deliver-and-collect) here? */
function replacementServiceable(pin) {
  const p = normalizePin(pin);
  if (!p || !pinSet().has(p)) return false;
  return !exceptions().noReplacement.has(p);
}

/**
 * Everything known about one pincode, for an admin screen.
 * `reason` is empty when the pincode is fine — it is there to be shown.
 */
function classify(pin) {
  const p = normalizePin(pin);
  if (!p) {
    return { pin: String(pin == null ? '' : pin), valid: false, serviceable: false,
             cod: false, reverse: false, replacement: false, cash: false,
             reason: 'not a valid 6-digit Indian pincode' };
  }
  if (!pinSet().has(p)) {
    return { pin: p, valid: true, serviceable: false,
             cod: false, reverse: false, replacement: false, cash: false,
             reason: 'not in Delhivery serviceable pincodes' };
  }
  const x = exceptions();
  const out = { pin: p, valid: true, serviceable: true,
                cod: !x.noCod.has(p), reverse: !x.noReverse.has(p),
                replacement: !x.noReplacement.has(p), cash: !x.noCash.has(p),
                reason: '' };
  if (!out.cod) out.reason = 'serviceable, but Delhivery does not collect COD here';
  return out;
}

/**
 * The shipping verdict for one ORDER: serviceable, and — when money is owed
 * at the door — COD-collectable too. A prepaid parcel to a no-COD pincode is
 * perfectly shippable, so the COD half is only asked when it is relevant.
 */
function canShip(pin, { isCOD = false } = {}) {
  const c = classify(pin);
  if (!c.serviceable) return { ok: false, reason: c.reason, detail: c };
  if (isCOD && !c.cod) return { ok: false, reason: c.reason, detail: c };
  return { ok: true, reason: '', detail: c };
}

module.exports = {
  normalizePin, isServiceable, codServiceable, reversePickupServiceable,
  replacementServiceable, classify, canShip,
  count: DATA.count, generatedAt: DATA.generatedAt,
};
