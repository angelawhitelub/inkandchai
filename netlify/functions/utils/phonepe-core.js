/**
 * Shared PhonePe PG-V2 helpers (OAuth token, refund, refund-status, order-status).
 *
 * Mirrors the exact, working request shape used in phonepe-refund.js:
 *   - Only Content-Type + Authorization headers (extra headers break PG-V2 auth).
 *   - Authorization MUST use the literal "O-Bearer" prefix (PhonePe's SDK hardcodes it).
 */

let _tokenCache = { authorization: null, expiresAt: 0 };

function phonePeHeaders(authorization) {
  return { 'Content-Type': 'application/json', 'Authorization': authorization };
}

function phonePeHost() {
  return process.env.PHONEPE_HOST || 'https://api.phonepe.com/apis';
}

async function getAccessToken(host = phonePeHost(), force = false) {
  if (!force && _tokenCache.authorization && Date.now() < _tokenCache.expiresAt - 60_000) {
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

// GET the current state of a refund we previously created (by our merchantRefundId).
// Returns { ok, status, state, data }. state ∈ PENDING|CONFIRMED|COMPLETED|FAILED|'' .
async function getRefundStatus(merchantRefundId, host = phonePeHost()) {
  const auth = await getAccessToken(host);
  const res = await fetch(
    `${host}/pg/payments/v2/refund/${encodeURIComponent(merchantRefundId)}/status`,
    { method: 'GET', headers: phonePeHeaders(auth) }
  );
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, state: String(data.state || data.status || '').toUpperCase(), data };
}

/**
 * The UTR of a completed refund, from a refund-status payload.
 *
 * This is the only reference the customer's bank can act on. We used to hand
 * them our own merchantRefundId (REFUND-IC-…-A0) — an id that means nothing to
 * anyone outside this codebase, so "quote this to your bank" was useless advice.
 * PhonePe nests the real one under paymentDetails[].rail.utr, the same shape the
 * payment sweep already reads for forward payments.
 */
function refundUtrFrom(data) {
  const details = Array.isArray(data?.paymentDetails) ? data.paymentDetails : [];
  const completed = details.find(d => String(d?.state || '').toUpperCase() === 'COMPLETED');
  for (const d of [completed, ...details]) {
    const utr = d?.rail?.utr || d?.utr || '';
    if (utr) return String(utr).trim();
  }
  return null;
}

// GET the order's overall status (includes refund transactions). Used as a
// double-refund guard when we have no stored merchantRefundId for an order.
async function getOrderStatus(merchantOrderId, host = phonePeHost()) {
  const auth = await getAccessToken(host);
  const res = await fetch(
    `${host}/pg/checkout/v2/order/${encodeURIComponent(merchantOrderId)}/status?details=true`,
    { method: 'GET', headers: phonePeHeaders(auth) }
  );
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// Scan a PhonePe order-status payload for the best refund state present.
// Returns 'COMPLETED' | 'PENDING' | 'FAILED' | null. Defensive across shapes.
function refundStateFromOrder(orderData) {
  if (!orderData || typeof orderData !== 'object') return null;
  const buckets = [];
  const push = (arr) => { if (Array.isArray(arr)) buckets.push(...arr); };
  push(orderData.refundDetails);
  push(orderData.refunds);
  // Some payloads nest refund txns inside paymentDetails[].refundDetails / .split
  for (const pd of (orderData.paymentDetails || [])) {
    push(pd.refundDetails); push(pd.refunds);
    if (/refund/i.test(String(pd.transactionType || pd.type || '')) || Number(pd.amount) < 0) buckets.push(pd);
  }
  const states = buckets.map(r => String(r.state || r.status || '').toUpperCase()).filter(Boolean);
  if (!states.length) return null;
  if (states.includes('COMPLETED') || states.includes('CONFIRMED') || states.includes('SUCCESS')) return 'COMPLETED';
  if (states.includes('PENDING') || states.includes('INITIATED')) return 'PENDING';
  if (states.every(s => s === 'FAILED')) return 'FAILED';
  return states[0];
}

// Create a refund. Tries v2, retries once on auth error with a fresh token,
// falls back to legacy v1 on ApiMappingNotFound. Returns { ok, status, state, data }.
async function issueRefund({ merchantRefundId, originalMerchantOrderId, amountPaise }, host = phonePeHost()) {
  const refundBody = { merchantRefundId, originalMerchantOrderId, amount: amountPaise };
  async function call(path, auth) {
    const r = await fetch(`${host}${path}`, {
      method: 'POST', headers: phonePeHeaders(auth), body: JSON.stringify(refundBody),
    });
    const text = await r.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    return { ok: r.ok, status: r.status, data };
  }
  let auth = await getAccessToken(host);
  let res = await call('/pg/payments/v2/refund', auth);
  if (!res.ok && /authorization|unauthori[sz]ed|invalid token/i.test(JSON.stringify(res.data))) {
    auth = await getAccessToken(host, true);           // force-refresh token, retry once
    res = await call('/pg/payments/v2/refund', auth);
  }
  if (!res.ok && /api mapping not found/i.test(JSON.stringify(res.data))) {
    res = await call('/pg/v1/refund', auth);           // legacy fallback
  }
  return { ...res, state: String(res.data?.state || res.data?.status || '').toUpperCase() };
}

module.exports = {
  phonePeHost, getAccessToken, getRefundStatus, getOrderStatus, refundStateFromOrder, issueRefund,
  refundUtrFrom,
};
