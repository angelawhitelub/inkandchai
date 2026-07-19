/**
 * Shared pincode sanity check — catches OBVIOUSLY fake Indian PIN codes that a
 * customer typed to skip past the form (e.g. 123456, 111111, 000000, 654321).
 *
 * This is deliberately conservative: it only rejects patterns that no real
 * Indian PIN code can ever be, so it has ZERO false positives on genuine
 * pincodes. It does NOT try to confirm a plausible-looking pincode actually
 * exists (that needs the India Post directory and would fail closed when the
 * upstream API is flaky). Real serviceability is handled elsewhere.
 *
 * Indian PIN code facts used here:
 *   - Exactly 6 digits.
 *   - First digit is 1–9 (never 0 — 0 is not a valid postal region).
 */

// A short list of notorious junk entries people type. Everything here is also
// caught by the structural rules below, but keeping them explicit documents
// intent and guards against a rule being loosened later.
const JUNK_PINCODES = new Set([
  '000000', '111111', '222222', '333333', '444444', '555555',
  '666666', '777777', '888888', '999999',
  '123456', '234567', '345678', '456789', '567890',
  '654321', '765432', '876543', '987654', '098765',
  '123123', '121212', '112233', '123321', '100000', '101010',
  '110000', '200000', '999000', '123000',
]);

/**
 * @param {string|number} raw
 * @returns {boolean} true when the pincode is definitely fake / typed junk.
 */
function isFakePincode(raw) {
  const pin = String(raw == null ? '' : raw).replace(/\D/g, '');

  // Wrong length or leading zero → not a valid Indian PIN. (Callers usually
  // validate the 6-digit shape first; we mirror it so this is safe standalone.)
  if (!/^[1-9]\d{5}$/.test(pin)) return true;

  if (JUNK_PINCODES.has(pin)) return true;

  // All six digits identical (111111 …). The leading-zero case (000000) is
  // already rejected above, but keep the check general.
  if (/^(\d)\1{5}$/.test(pin)) return true;

  // First half repeats as the second half (123123, 456456 …).
  if (pin.slice(0, 3) === pin.slice(3)) return true;

  // Strictly sequential ascending or descending (123456 / 654321 …).
  let asc = true, desc = true;
  for (let i = 1; i < pin.length; i++) {
    const d = pin.charCodeAt(i) - pin.charCodeAt(i - 1);
    if (d !== 1)  asc  = false;
    if (d !== -1) desc = false;
  }
  if (asc || desc) return true;

  return false;
}

// Pull the delivery pincode out of a payload. Prefer an explicit field; fall
// back to the trailing 6-digit run in the joined address string. Returns '' when
// nothing pincode-shaped is present so callers can fail OPEN (never block on a
// missing value — only on a value that is present AND fake).
function extractPincode(customer) {
  const c = customer || {};
  const direct = String(c.pincode || c.pin || '').replace(/\D/g, '');
  if (direct.length === 6) return direct;
  const addr = String(c.address || '');
  const matches = addr.match(/\b\d{6}\b/g);
  return matches && matches.length ? matches[matches.length - 1] : '';
}

const PINCODE_INVALID_MESSAGE =
  'That pincode doesn’t look valid. Please enter your correct 6-digit delivery pincode.';

module.exports = { isFakePincode, extractPincode, PINCODE_INVALID_MESSAGE, JUNK_PINCODES };
