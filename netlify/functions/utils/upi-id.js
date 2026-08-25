'use strict';

/**
 * Validate a customer-typed UPI ID (VPA).
 *
 * We ask for this in exactly one place: a COD order that arrived with a book
 * missing. A prepaid refund goes back to the card or UPI that paid, but nobody
 * paid us online for a COD parcel, so if the missing book turns out to be
 * unarrangeable there is no instrument to refund to — hence asking, optionally
 * and up front, rather than chasing the customer weeks later.
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

/**
 * @param {string} raw
 * @returns {{ ok: boolean, value: string, reason: string }}
 *   ok:false with reason '' means "nothing was supplied" — the field is optional.
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

module.exports = { normalizeUpiId };
