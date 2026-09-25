/**
 * Normalise customer data to NimbusPost's strict requirements so orders push
 * through instead of failing on messy real-world input:
 *   - phone  → exactly 10 digits (Indian mobile), as a STRING (Number() would
 *              drop a leading 0 and yield 9 chars → "phone must be exactly 10")
 *   - pincode → the 6-digit code found ANYWHERE in the address, not just in a
 *              comma segment (bot addresses are often comma-less free text).
 *              When there are two DIFFERENT codes, see pickPincode: it keeps
 *              the one in the state the address names, or refuses to guess.
 *   - city/state → parsed from the address, and if that fails, DERIVED from the
 *              pincode via the India Post API (that's the "auto-adjust")
 */

// Memoise pincode → {city,state} for the life of the function invocation so a
// bulk push of many same-city orders makes at most one lookup per pincode.
const { pincodeInState, stateInAddress } = require('./pincode-state');

const PIN_CACHE = new Map();

/** Strip to a 10-digit Indian mobile string, or '' if not recoverable. */
function normalizeIndianPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  // Strip a leading country code / trunk 0 before taking the last 10.
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  let ten = d.slice(-10);
  // Indian mobiles start 6-9. If the last 10 don't, hunt for a valid run
  // (handles pasted "call 0821-... / +91 98..." style junk).
  if (!/^[6-9]/.test(ten)) {
    const m = d.match(/[6-9]\d{9}/);
    if (m) ten = m[0];
  }
  return ten.length === 10 ? ten : '';
}

/**
 * The pincode in a free-text address.
 *
 * One distinct 6-digit code: that is it. The hard case is TWO DIFFERENT codes,
 * which happens when a customer pastes a full address (pincode included) into
 * the street line and then fills the pincode field too. Checkout stores
 * [street, city, state, pincode].join(', '), so the field is the last code.
 *
 * Neither "first" nor "last" is right on its own, and both have cost parcels:
 *   first wrong  IC-20260905-U8RZQ  "..., (561202), ..., Pune, Maharashtra, 411028"
 *                shipped to 561202 (Karnataka) and came back RTO.
 *   last wrong   IC-CW-20260918-PL08Q  "...Lokhandwala, Andheri West, Mumbai
 *                400053, Mumbai, Maharashtra, 400005" -- Lokhandwala is
 *                400053; the field's 400005 is Colaba.
 *
 * So: keep only the codes that lie in the state the address names. If exactly
 * one survives, that is the pincode. Otherwise return NO pincode and say why:
 * every courier path refuses an order without one, which puts a person in
 * front of an address a program cannot read, instead of a parcel in the wrong
 * city.
 *
 * Returns { pincode, index, candidates, problem }. `index` is where the chosen
 * code sits, so the caller strips THAT occurrence and not an earlier copy.
 */
function pickPincode(raw) {
  const re = /\b([1-9]\d{5})\b/g;
  const hits = [];
  let m;
  while ((m = re.exec(raw)) !== null) hits.push({ pincode: m[1], index: m.index });
  if (!hits.length) return { pincode: '', index: -1, candidates: [], problem: '' };

  const distinct = [...new Set(hits.map((h) => h.pincode))];
  const lastOf = (pin) => hits.filter((h) => h.pincode === pin).pop();
  if (distinct.length === 1) return { ...lastOf(distinct[0]), candidates: distinct, problem: '' };

  const state = stateInAddress(raw);
  const inState = state ? distinct.filter((pin) => pincodeInState(pin, state)) : [];
  if (inState.length === 1) return { ...lastOf(inState[0]), candidates: distinct, problem: '' };

  const why = !state
    ? 'no state is named to choose between them'
    : inState.length === 0
      ? `neither is in ${state}, the state the address names`
      : `both are in ${state}`;
  return {
    pincode: '', index: -1, candidates: distinct,
    problem: `Address has ${distinct.length} different pincodes (${distinct.join(', ')}) and ${why}. ` +
             'Correct the address to the one right pincode, then push again.',
  };
}

/** Best-effort {address, city, state, pincode} from a free-text address. */
function parseAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return { address: '', city: '', state: '', pincode: '' };

  // Pincode: see pickPincode (Indian pincodes never start with 0).
  const { pincode, index, candidates, problem } = pickPincode(raw);

  // Working copy with the pincode and any "pin/pincode" label stripped out.
  // Cut the pincode by position first, so an identical run of digits earlier
  // in the street line survives.
  let work = pincode ? raw.slice(0, index) + ' ' + raw.slice(index + pincode.length) : raw;
  // Refused as ambiguous: the tail still ends in a pincode, which would
  // otherwise be read as the state.
  if (!pincode && candidates.length > 1) work = work.replace(/,\s*[1-9]\d{5}\s*$/, '');
  work = work.replace(/\b(pin\s*code|pincode|pin|postal\s*code)\b[:\s-]*/gi, ' ');
  work = work.replace(/\s{2,}/g, ' ').replace(/\s*,\s*/g, ', ').trim().replace(/,\s*$/, '').trim();

  const parts = work.split(',').map(s => s.trim()).filter(Boolean);
  let city = '', state = '', address = '';
  // Only treat the tail as city + state when there is a street line LEFT OVER.
  // At exactly two segments the old code popped both and left `address` empty,
  // and NimbusPost rejects the push with "address is required" — that is what
  // killed "House No A-68 ... , Near Kendriya Bhandar Pin code 110021", where
  // both segments are street. Two segments can't be told apart from
  // [street, city] anyway, so keep the whole line and let the pincode supply
  // city/state, which is authoritative rather than guessed.
  if (parts.length >= 3) {
    state   = parts.pop();
    city    = parts.pop();
    address = parts.join(', ');
  } else {
    address = parts.join(', ') || work;   // keep whole line; city/state come from pincode
  }
  // Belt and braces: never emit a blank address line, whatever the input shape.
  if (!address.trim()) address = [work, city, state].map(s => String(s || '').trim()).filter(Boolean).join(', ');
  return {
    address: address.slice(0, 200),
    city:    city.slice(0, 64),
    state:   state.slice(0, 64),
    pincode,
    // Set only when the address holds conflicting pincodes and none could be
    // chosen safely. Callers put this in their error instead of the generic
    // "no pincode", so the person fixing it knows what to fix.
    pincodeProblem: problem || '',
  };
}

/** Look up {city, state} for a pincode via India Post (cached, timeout-guarded). */
async function cityStateFromPincode(pincode) {
  if (!pincode) return null;
  if (PIN_CACHE.has(pincode)) return PIN_CACHE.get(pincode);
  let out = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`https://api.postalpincode.in/pincode/${pincode}`, { signal: ctrl.signal });
    clearTimeout(t);
    const data = await res.json().catch(() => null);
    const po = Array.isArray(data) && data[0] && data[0].Status === 'Success'
      ? (data[0].PostOffice || [])[0]
      : null;
    if (po) out = { city: po.District || po.Block || po.Name || '', state: po.State || '' };
  } catch (_) { /* network/timeout — fall through to null */ }
  PIN_CACHE.set(pincode, out);
  return out;
}

/** Fill missing city/state from the pincode. Mutates and returns addr. */
async function enrichAddress(addr) {
  if (addr && addr.pincode && (!addr.city || !addr.state)) {
    const cs = await cityStateFromPincode(addr.pincode);
    if (cs) {
      if (!addr.city)  addr.city  = cs.city;
      if (!addr.state) addr.state = cs.state;
    }
  }
  return addr;
}

module.exports = { normalizeIndianPhone, parseAddress, cityStateFromPincode, enrichAddress, pickPincode };
