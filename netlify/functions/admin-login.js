/**
 * POST /.netlify/functions/admin-login
 * Body: { password }
 *
 * Validates the admin password (ADMIN_SECRET / ADMIN_PASSWORD env var)
 * with a constant-time compare. On success returns a signed admin token
 * (preferred) and the raw key (legacy, for one-release transition).
 *
 * Previously the admin SPA just kept the plaintext password in memory and
 * sent it on every request — XSS anywhere on /admin meant full takeover
 * with no expiry. The token here has an 8h TTL and is HMAC-signed; even
 * if exfiltrated it auto-revokes.
 */

const crypto = require('crypto');
const { signAdminToken } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

function timingEq(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  if (A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A, B); } catch { return false; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const password = String(body.password || '');
  if (!password) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Password required' }) };

  const a = process.env.ADMIN_SECRET   || '';
  const b = process.env.ADMIN_PASSWORD || '';
  if (!a && !b) {
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: 'Admin auth not configured' }) };
  }
  const ok = timingEq(password, a) || timingEq(password, b);

  // Small constant delay to blunt online password-guessing (rate-limiting is
  // separately handled at the CDN; this is just a polite floor).
  await new Promise(r => setTimeout(r, 250));

  if (!ok) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid password' }) };
  }

  let adminToken;
  try { adminToken = signAdminToken({ sub: 'password' }); }
  catch (e) { return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: e.message }) }; }

  return {
    statusCode: 200,
    headers: CORS,
    // adminKey is the same value the caller sent — we don't echo it back; the
    // SPA already has the password in memory if it needs the legacy fallback.
    // (Returning it adds zero security on top, and one more place it can leak.)
    body: JSON.stringify({ ok: true, adminToken }),
  };
};
