/**
 * Signed review links.
 *
 * submit-review used to require a Supabase JWT, which sounds right but made
 * the feature impossible to use: /review/ has no sign-in, so every submission
 * returned 401 and the table stayed empty. Dropping the check entirely would
 * restore the original hole -- anyone with a leaked order id could post a 5-star
 * "Verified Buyer" review for any product.
 *
 * So the review link itself carries proof that we sent it. request-reviews mints
 * a short HMAC over the order id; submit-review accepts either a valid JWT (for
 * a signed-in customer) or a valid token. Guest buyers -- most of our orders --
 * can review in one tap, and only someone we actually messaged holds a token.
 *
 * The token is not a secret handed to a third party: it goes to the buyer's own
 * WhatsApp, and it authorises exactly one thing (reviewing an order that is
 * already delivered and not yet reviewed).
 */

const crypto = require('crypto');

// Domain-separated so a token minted here can never be replayed against any
// other ADMIN_SECRET-derived check, and vice versa.
const LABEL = 'review-link:v1:';

function secret() {
  return process.env.REVIEW_LINK_SECRET || process.env.ADMIN_SECRET || '';
}

/** Signed token for an order id, or '' when no secret is configured. */
function signReviewToken(orderId) {
  const key = secret();
  const id = String(orderId || '').trim();
  if (!key || !id) return '';
  return crypto.createHmac('sha256', key).update(LABEL + id).digest('base64url').slice(0, 24);
}

/** Constant-time check of a token against an order id. */
function verifyReviewToken(orderId, token) {
  const expected = signReviewToken(orderId);
  const got = String(token || '').trim();
  if (!expected || !got || expected.length !== got.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
  } catch (_) {
    return false;
  }
}

module.exports = { signReviewToken, verifyReviewToken };
