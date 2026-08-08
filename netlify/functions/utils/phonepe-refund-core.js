/**
 * utils/phonepe-refund-core.js
 *
 * Self-contained PhonePe refund helper for PROGRAMMATIC (automatic) refunds —
 * e.g. auto-refunding a prepaid order when it's cancelled. It mirrors the proven
 * logic in netlify/functions/phonepe-refund.js exactly (verified against PhonePe's
 * own pg-sdk-node):
 *   • OAuth:   POST {host}/identity-manager/v1/oauth/token  → O-Bearer <token>
 *   • Refund:  POST {host}/pg/payments/v2/refund
 *              body { merchantRefundId, originalMerchantOrderId, amount(paise) }
 *              headers: Content-Type + Authorization only (extra headers 401)
 *
 * Kept SEPARATE from the admin refund endpoint so auto-refund can never break
 * the manual refund flow.
 *
 * Env: PHONEPE_CLIENT_ID, PHONEPE_CLIENT_SECRET, PHONEPE_CLIENT_VERSION, PHONEPE_HOST
 */

const { refundIdForAttempt } = require('./refund-id');

let _tokenCache = { authorization: null, expiresAt: 0 };

async function getAccessToken(host) {
  if (_tokenCache.authorization && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.authorization;
  }
  const body = new URLSearchParams({
    client_id: process.env.PHONEPE_CLIENT_ID,
    client_secret: process.env.PHONEPE_CLIENT_SECRET,
    client_version: process.env.PHONEPE_CLIENT_VERSION || '1',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`${host}/identity-manager/v1/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error('PhonePe OAuth failed: ' + (data.message || data.error || ('HTTP ' + res.status)));
  }
  _tokenCache = {
    authorization: `O-Bearer ${data.access_token}`,
    expiresAt: data.expires_at ? data.expires_at * 1000 : Date.now() + (data.expires_in || 3300) * 1000,
  };
  return _tokenCache.authorization;
}

function phonePeHeaders(authorization) {
  return { 'Content-Type': 'application/json', 'Authorization': authorization };
}

/**
 * Issue a refund for a PhonePe-paid order.
 * @param {object} opts
 * @param {string} opts.displayId   - the merchant order id (IC-…) used at pay time
 * @param {number} opts.amountPaise - refund amount in paise (full order amount for a full refund)
 * @returns {Promise<{ok:boolean, state?:string, refundId?:string, merchantRefundId:string, nextStatus?:string, error?:string}>}
 */
async function issuePhonePeRefund({ displayId, amountPaise, attempt = 0 }) {
  const host = process.env.PHONEPE_HOST || 'https://api.phonepe.com/apis';
  // Attempt-derived, never clock-derived — see utils/refund-id.js. A timestamp
  // id cannot be reconstructed later, so a refund that completed under it became
  // invisible and the order looked unrefunded forever.
  const merchantRefundId = refundIdForAttempt(displayId, attempt);
  const refundBody = {
    merchantRefundId,
    originalMerchantOrderId: displayId,
    amount: Math.round(amountPaise),
  };

  async function call(authorization) {
    const r = await fetch(`${host}/pg/payments/v2/refund`, {
      method: 'POST',
      headers: phonePeHeaders(authorization),
      body: JSON.stringify(refundBody),
    });
    const text = await r.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    return { ok: r.ok, status: r.status, data };
  }

  let auth = await getAccessToken(host);
  let res = await call(auth);

  // Warm-Lambda bad-token guard: drop cache and retry once with a fresh token.
  if (!res.ok && /authorization|unauthori[sz]ed|invalid token/i.test(JSON.stringify(res.data))) {
    _tokenCache = { authorization: null, expiresAt: 0 };
    auth = await getAccessToken(host);
    res = await call(auth);
  }

  if (!res.ok) {
    return {
      ok: false,
      merchantRefundId,
      error: res.data.message || res.data.error || res.data.errorCode || `HTTP ${res.status}`,
    };
  }

  const state = String(res.data.state || res.data.status || '').toUpperCase();
  if (state === 'FAILED') {
    return { ok: false, merchantRefundId, error: res.data.message || 'PhonePe rejected the refund' };
  }
  // PhonePe usually returns PENDING first; the webhook/status API moves it to COMPLETED.
  const nextStatus = state === 'COMPLETED' ? 'refunded' : 'refund_pending';
  return { ok: true, state, refundId: res.data.refundId || null, merchantRefundId, nextStatus };
}

module.exports = { issuePhonePeRefund };
