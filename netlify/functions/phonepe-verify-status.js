/**
 * Netlify Function: phonepe-verify-status
 * GET /.netlify/functions/phonepe-verify-status?id=<orderId>
 *
 * PhonePe redirects the customer here after payment. We hit the v2
 * status endpoint with an OAuth token, then 302 the customer to:
 *   - /checkout/?paid=1&id=<orderId>     on COMPLETED
 *   - /checkout/?failed=1&id=<orderId>   on FAILED / CANCELLED / unknown
 *
 * The webhook (separate function) does the DB write + email — this
 * function only handles the customer-visible redirect after PhonePe.
 */

let _tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken(host) {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }
  const body = new URLSearchParams({
    client_id:      process.env.PHONEPE_CLIENT_ID,
    client_secret:  process.env.PHONEPE_CLIENT_SECRET,
    client_version: process.env.PHONEPE_CLIENT_VERSION || '1',
    grant_type:     'client_credentials',
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
    token: data.access_token,
    expiresAt: data.expires_at ? data.expires_at * 1000 : Date.now() + (data.expires_in || 3300) * 1000,
  };
  return _tokenCache.token;
}

exports.handler = async (event) => {
  const id = event.queryStringParameters?.id;
  const siteUrl = process.env.SITE_URL || 'https://inkandchai.in';
  const host = process.env.PHONEPE_HOST || 'https://api.phonepe.com/apis';

  if (!id) {
    return { statusCode: 302, headers: { Location: siteUrl + '/checkout/?failed=1' }, body: '' };
  }

  try {
    const token = await getAccessToken(host);
    const res = await fetch(`${host}/pg/checkout/v2/order/${encodeURIComponent(id)}/status`, {
      headers: { 'Authorization': 'O-Bearer ' + token },
    });
    const data = await res.json().catch(() => ({}));
    const state = (data.state || '').toUpperCase();

    if (state === 'COMPLETED') {
      return {
        statusCode: 302,
        headers: { Location: `${siteUrl}/checkout/?paid=1&id=${encodeURIComponent(id)}` },
        body: '',
      };
    }
    return {
      statusCode: 302,
      headers: { Location: `${siteUrl}/checkout/?failed=1&id=${encodeURIComponent(id)}&code=${encodeURIComponent(state || 'UNKNOWN')}` },
      body: '',
    };
  } catch (err) {
    console.error('PhonePe v2 status error:', err);
    return {
      statusCode: 302,
      headers: { Location: `${siteUrl}/checkout/?failed=1&id=${encodeURIComponent(id)}` },
      body: '',
    };
  }
};
