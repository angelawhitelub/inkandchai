'use strict';

/**
 * Signed refund-UPI links.
 *
 * When a missing-book replacement is cancelled on a COD order there is nothing
 * to reverse -- the courier handed us cash, no gateway holds a payment -- so the
 * refund has to be pushed to a UPI handle the customer gives us. Asking them to
 * reply with it means someone reads a mailbox and retypes a VPA, and a mistyped
 * handle sends money nowhere.
 *
 * So the email carries a link that opens a form for exactly one order. The token
 * is an HMAC over the replacement id: only someone we actually emailed holds
 * one, and it authorises precisely one thing -- naming the payout target for a
 * refund that is already owed.
 *
 * Modelled on utils/review-token.js, with its own label so a token minted for
 * one purpose can never be replayed against the other.
 */

const crypto = require('crypto');

const LABEL = 'refund-upi:v1:';

function secret() {
  return process.env.REFUND_UPI_LINK_SECRET || process.env.REVIEW_LINK_SECRET || process.env.ADMIN_SECRET || '';
}

/** Signed token for a replacement order id, or '' when no secret is configured. */
function signRefundUpiToken(orderId) {
  const key = secret();
  const id = String(orderId || '').trim();
  if (!key || !id) return '';
  return crypto.createHmac('sha256', key).update(LABEL + id).digest('base64url').slice(0, 24);
}

/** Constant-time check of a token against a replacement order id. */
function verifyRefundUpiToken(orderId, token) {
  const expected = signRefundUpiToken(orderId);
  const got = String(token || '').trim();
  if (!expected || !got || expected.length !== got.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
  } catch (_) {
    return false;
  }
}

module.exports = { signRefundUpiToken, verifyRefundUpiToken };
