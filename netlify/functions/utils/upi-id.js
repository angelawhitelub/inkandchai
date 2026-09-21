'use strict';

/**
 * Validate a customer-typed UPI ID (VPA).
 *
 * The case that drives this: a COD order that arrived with a book missing. A
 * prepaid refund goes back to the card or UPI that paid, but nobody paid us
 * online for a COD parcel, so if the missing book turns out to be unarrangeable
 * there is no instrument to refund to. On that one flow the handle is REQUIRED
 * (see requireUpiId) — asked while the customer is still on the page and still
 * wants something from us, rather than chased weeks later when they have
 * stopped replying and the money owed just sits there.
 *
 * Because a human types it and a wrong handle silently sends money nowhere,
 * this is deliberately stricter than "contains an @":
 *   • the handle after @ must be alphabetic-ish (ybl, okhdfcbank, paytm, upi)
 *   • an email address is rejected outright — .com / .in / .co.in are the
 *     mistake customers actually make, and `someone@gmail.com` otherwise looks
 *     exactly like a VPA
 */

// account@psp — account part allows letters, digits, dot, hyphen, underscore.
const VPA_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{1,63})@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;
// The handles of real PSPs are not domains. Anything ending like one is an email.
const EMAILISH_RE = /\.(com|in|net|org|co\.in|co|io|edu|gov)$/i;

// Shown when a COD customer submits a missing-book report with the field empty.
// Phrased as what to type and why, not as a validation failure: the customer is
// being asked for a payment address in the middle of telling us something went
// wrong, and "required field" is not a reason anyone accepts for that.
const UPI_REQUIRED_REASON =
  'Please add the UPI ID we should send your refund to. This order was Cash on Delivery, '
  + 'so there is no online payment for us to reverse — for example 9876543210@ybl.';

/**
 * @param {string} raw
 * @returns {{ ok: boolean, value: string, reason: string }}
 *   ok:false with reason '' means "nothing was supplied". Whether that is
 *   allowed is the caller's decision: requireUpiId turns it into an error.
 */
function normalizeUpiId(raw) {
  const value = String(raw == null ? '' : raw).trim().replace(/\s+/g, '');
  if (!value) return { ok: false, value: '', reason: '' };
  if (value.length > 128) return { ok: false, value: '', reason: 'That UPI ID is too long.' };
  if (!value.includes('@')) {
    return { ok: false, value: '', reason: 'A UPI ID looks like name@bank — for example 9876543210@ybl.' };
  }
  const handle = value.slice(value.lastIndexOf('@') + 1);
  if (EMAILISH_RE.test(handle)) {
    return { ok: false, value: '', reason: 'That looks like an email address. Please enter your UPI ID — for example 9876543210@ybl or name@okaxis.' };
  }
  if (!VPA_RE.test(value)) {
    return { ok: false, value: '', reason: 'That does not look like a valid UPI ID. Check it and try again — for example 9876543210@ybl.' };
  }
  return { ok: true, value, reason: '' };
}

/**
 * normalizeUpiId, except that leaving the field blank is itself an error.
 *
 * Use this wherever the handle is the ONLY way the money can get back — today
 * that is a missing book on a COD order. Where the gateway can reverse the
 * original payment, use normalizeUpiId and let an empty field pass: a UPI ID we
 * have no use for is personal data we should not be holding.
 *
 * @param {string} raw
 * @returns {{ ok: boolean, value: string, reason: string }}  reason is never ''
 *   when ok is false — there is always something to show the customer.
 */
function requireUpiId(raw) {
  const result = normalizeUpiId(raw);
  if (!result.ok && !result.reason) return { ok: false, value: '', reason: UPI_REQUIRED_REASON };
  return result;
}

module.exports = { normalizeUpiId, requireUpiId, UPI_REQUIRED_REASON };
