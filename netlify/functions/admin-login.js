/**
 * POST /.netlify/functions/admin-login
 * Body: { email, password, remember }
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
const { createClient } = require('@supabase/supabase-js');
const { TOKEN_TTL_MS, ADMIN_COOKIE_NAME, signAdminToken } = require('./utils/admin-auth');

const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

function verifyStaffPassword(password, encoded) {
  try {
    const [prefix, nRaw, rRaw, saltHex, digestHex] = String(encoded || '').split('$');
    if (prefix !== 'scrypt' || !saltHex || !digestHex) return false;
    const derived = crypto.scryptSync(String(password || ''), Buffer.from(saltHex, 'hex'), digestHex.length / 2, {
      N: Number(nRaw) || 16384, r: Number(rRaw) || 8, p: 1,
    });
    const expected = Buffer.from(digestHex, 'hex');
    return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
  } catch { return false; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const remember = body.remember !== false;
  if (!email || !password) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Email and password required' }) };
  }

  const configuredEmail = String(process.env.ADMIN_EMAIL || process.env.STORE_OWNER_EMAIL || '').trim().toLowerCase();
  const a = process.env.ADMIN_SECRET   || '';
  const b = process.env.ADMIN_PASSWORD || '';
  if (!configuredEmail || (!a && !b)) {
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: 'Admin email login is not configured' }) };
  }
  let role = 'owner';
  let ok = timingEq(email, configuredEmail) && (timingEq(password, a) || timingEq(password, b));

  // Staff credentials are stored as salted scrypt hashes in Supabase. A
  // missing table is treated as “no staff match”, preserving owner login.
  if (!ok && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    try {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data: staff } = await sb.from('admin_users')
        .select('email, role, password_hash, active')
        .eq('email', email).eq('active', true).maybeSingle();
      if (staff && verifyStaffPassword(password, staff.password_hash)) {
        ok = true;
        role = String(staff.role || 'support');
      }
    } catch (e) {
      console.warn('[admin-login] staff lookup unavailable:', e.message);
    }
  }

  // Small constant delay to blunt online password-guessing (rate-limiting is
  // separately handled at the CDN; this is just a polite floor).
  await new Promise(r => setTimeout(r, 250));

  if (!ok) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid email or password' }) };
  }

  // Owner may remember this browser for 30 days. Staff sessions are capped at
  // the normal 8-hour token lifetime even when “remember” is checked.
  const ttlMs = role === 'owner' && remember ? REMEMBER_TTL_MS : TOKEN_TTL_MS;
  const expiresAt = Date.now() + ttlMs;
  let adminToken;
  try { adminToken = signAdminToken({ sub: `email:${email}`, role, ttlMs }); }
  catch (e) { return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: e.message }) }; }

  const cookie = [
    `${ADMIN_COOKIE_NAME}=${adminToken}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
  ].join('; ');

  return {
    statusCode: 200,
    headers: { ...CORS, 'Set-Cookie': cookie, 'Cache-Control': 'no-store' },
    // adminKey is the same value the caller sent — we don't echo it back; the
    // SPA already has the password in memory if it needs the legacy fallback.
    // (Returning it adds zero security on top, and one more place it can leak.)
    body: JSON.stringify({ ok: true, adminToken, expiresAt, email, role }),
  };
};
