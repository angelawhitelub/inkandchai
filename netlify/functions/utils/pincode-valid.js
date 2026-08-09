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

const PINCODE_NOT_FOUND_MESSAGE =
  'That pincode doesn’t exist in India Post records. Please check your 6-digit delivery pincode.';

// Shown when NO courier will carry to the pincode. Deliberately not "invalid" —
// the customer may well have typed what they believe is their pincode.
const PINCODE_UNDELIVERABLE_MESSAGE =
  'We couldn’t find any courier that delivers to that pincode. Please double-check your 6-digit delivery pincode.';

// ── Existence check (authoritative) ──────────────────────────────────────────
// isFakePincode above only catches typed junk. A pincode can be perfectly
// well-formed and still have no delivery office at all — 206014 is real-looking
// (206xxx is the Etawah/Auraiya range) but India Post has no record of it, and
// an order shipped to it on a Lucknow address.
//
// The browser already asks pincode-lookup for this, but that check is racy (a
// 500ms debounce the customer can out-click) and client-side, so it cannot be
// the gate. This runs on the server, where it actually decides.
//
// Returns TRUE (exists), FALSE (India Post explicitly has no record), or NULL
// (unknown — unreachable, timed out, or an unexpected shape). Callers MUST fail
// open on null: a flaky upstream must never block a genuine order.
const INDIA_POST_URL = 'https://api.postalpincode.in/pincode/';

async function pincodeExists(raw, opts = {}) {
  const { timeoutMs = 2500, fetchImpl = globalThis.fetch } = opts;
  const pin = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!/^[1-9]\d{5}$/.test(pin)) return null;   // shape is isFakePincode's job
  if (typeof fetchImpl !== 'function') return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(INDIA_POST_URL + pin, { signal: controller.signal });
    if (!res || !res.ok) return null;
    const body = await res.json();
    const rec = Array.isArray(body) ? body[0] : null;
    if (!rec) return null;
    if (rec.Status === 'Success' && Array.isArray(rec.PostOffice) && rec.PostOffice.length) return true;
    // Only a definite "no records found" counts as a denial. Any other error
    // string is treated as unknown so upstream hiccups fail open.
    if (/no records? found/i.test(String(rec.Message || ''))) return false;
    return null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Deliverability (the check that actually decides) ─────────────────────────
// India Post's dataset is INCOMPLETE. Measured against 8,274 real orders on
// 2026-08-10: 87 distinct pincodes had "no records found", but NimbusPost
// serviceability showed 22–37 couriers for most of them — 452008 (Indore),
// 122022 (Gurgaon), 440004, 560114, 201318, 400036 are all real and 34 such
// orders had already been DELIVERED. Blocking on India Post alone would have
// turned away paying customers.
//
// Only two pincodes came back with ZERO couriers: 206014 and 364042 — exactly
// the two that shipped and could not be delivered. So courier serviceability is
// the honest test of "can we actually send a book here".
//
// Returns TRUE (some courier serves it), FALSE (no courier does), or NULL
// (unknown — no credentials, login failed, timeout). Callers fail open on null.
const NP_BASE = 'https://api.nimbuspost.com/v1';
let _npToken = null;          // cached per warm lambda; cheap to re-fetch

async function npLogin(fetchImpl, signal) {
  if (_npToken) return _npToken;
  const res = await fetchImpl(`${NP_BASE}/users/login`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.NIMBUSPOST_EMAIL,
      password: process.env.NIMBUSPOST_PASSWORD,
    }),
  });
  const body = await res.json();
  _npToken = body?.data || null;
  return _npToken;
}

async function pincodeDeliverable(raw, opts = {}) {
  const { timeoutMs = 5000, fetchImpl = globalThis.fetch, origin = '110006' } = opts;
  const pin = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!/^[1-9]\d{5}$/.test(pin)) return null;
  if (typeof fetchImpl !== 'function') return null;
  if (!process.env.NIMBUSPOST_EMAIL || !process.env.NIMBUSPOST_PASSWORD) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const token = await npLogin(fetchImpl, controller.signal);
    if (!token) return null;
    const res = await fetchImpl(`${NP_BASE}/courier/serviceability`, {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin, destination: pin, payment_type: 'prepaid', order_amount: 300, weight: 400,
      }),
    });
    if (!res || !res.ok) return null;
    const body = await res.json();
    if (body?.status !== true) return null;             // an error shape → unknown
    if (!Array.isArray(body.data)) return null;
    return body.data.length > 0;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// One guard for every order-creating endpoint (Razorpay, PhonePe, COD) so the
// three can't drift — that drift is the whole reason a bad pincode shipped.
// Resolves to a {error, code} body to return with a 400, or null to proceed.
//
// TWO-STAGE on purpose. India Post is cheap and clears ~98% of pincodes, but it
// is NOT authoritative enough to refuse an order on its own (see above). Only
// when it reports no record do we escalate to the courier check, and only a
// confirmed ZERO-courier answer blocks. Everything else — no pincode, an
// unreachable lookup, an unexpected shape — fails open. Refusing a real
// customer's money is worse than the occasional undeliverable parcel.
async function pincodeRejection(customer, opts) {
  const pin = extractPincode(customer);
  if (!pin) return null;
  if (isFakePincode(pin)) {
    return { error: PINCODE_INVALID_MESSAGE, code: 'invalid_pincode' };
  }
  if ((await pincodeExists(pin, opts)) !== false) return null;   // known or unknown → allow
  if ((await pincodeDeliverable(pin, opts)) === false) {
    return { error: PINCODE_UNDELIVERABLE_MESSAGE, code: 'pincode_undeliverable' };
  }
  return null;
}

module.exports = {
  isFakePincode, extractPincode, pincodeExists, pincodeDeliverable, pincodeRejection,
  PINCODE_INVALID_MESSAGE, PINCODE_NOT_FOUND_MESSAGE, PINCODE_UNDELIVERABLE_MESSAGE,
  JUNK_PINCODES,
  _resetNpToken: () => { _npToken = null; },   // tests only
};
