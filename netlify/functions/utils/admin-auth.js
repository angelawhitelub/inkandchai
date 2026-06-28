/**
 * Centralised admin authentication.
 *
 * Why this exists:
 *   - Previously every admin function did its own ad-hoc check, half of them
 *     `if (adminKey && sent !== adminKey)` which is fail-OPEN if ADMIN_SECRET
 *     is unset (already burned us once).
 *   - Passkey login was returning the raw ADMIN_SECRET to the browser, so any
 *     stored-XSS on /admin would hand an attacker permanent god-mode.
 *
 * New model:
 *   1. Successful login (password OR passkey) returns a *signed token* —
 *      HMAC-SHA256({iat, exp, sub}) using ADMIN_TOKEN_SECRET (falls back to
 *      ADMIN_SECRET if the dedicated env var isn't set).
 *   2. Browser sends it as `X-Admin-Token` on every protected request.
 *   3. Tokens expire after `TOKEN_TTL_MS` (default 8 h) — server enforces.
 *   4. For transition we also accept the legacy `X-Admin-Key: <ADMIN_SECRET>`
 *      header, compared with `timingSafeEqual` so equality leaks no timing.
 *   5. `requireAdmin(event)` is a one-liner gate: returns null when OK, or
 *      an HTTP 401/503 response when not. Use at the top of every handler.
 */

const crypto = require('crypto');

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const TOKEN_VERSION = 'v1';

function getSigningSecret() {
  // Prefer a dedicated env var so rotating signing keys doesn't lock people
  // out of admin endpoints that gate on ADMIN_SECRET equality.
  return process.env.ADMIN_TOKEN_SECRET || process.env.ADMIN_SECRET || '';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function sign(payloadObj, secret) {
  const body = b64url(JSON.stringify(payloadObj));
  const mac  = crypto.createHmac('sha256', secret).update(body).digest();
  return `${TOKEN_VERSION}.${body}.${b64url(mac)}`;
}

/**
 * Issue a signed admin token. Optional sub identifies the principal
 * (e.g. "passkey:cred_xyz" or "password").
 */
function signAdminToken({ sub = 'admin', ttlMs = TOKEN_TTL_MS } = {}) {
  const secret = getSigningSecret();
  if (!secret) throw new Error('No signing secret configured');
  const now = Date.now();
  return sign({ iat: now, exp: now + ttlMs, sub }, secret);
}

/** Returns the payload object if valid, otherwise null. */
function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return null;
  const secret = getSigningSecret();
  if (!secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const [, body, mac] = parts;
  const expected = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  // Constant-time compare on equal-length strings only.
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(body).toString('utf8')); }
  catch { return null; }
  if (typeof payload?.exp !== 'number' || Date.now() > payload.exp) return null;
  return payload;
}

function legacyKeyOk(sent) {
  const expected = process.env.ADMIN_SECRET || '';
  if (!expected || !sent) return false;
  const a = Buffer.from(String(sent));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

/**
 * Returns true if the request carries a valid admin token (preferred)
 * OR the legacy admin key. Constant-time comparison throughout.
 */
function isAdminAuthed(event) {
  const headers = event.headers || {};
  const token =
    headers['x-admin-token'] || headers['X-Admin-Token'] ||
    headers['x-admin-Token'] || '';
  if (token && verifyAdminToken(token)) return true;
  const key =
    headers['x-admin-key'] || headers['X-Admin-Key'] || '';
  return legacyKeyOk(key);
}

/**
 * Drop-in gate: returns null when authed, or a finished 401/503 response.
 *
 *   exports.handler = async (event) => {
 *     const block = requireAdmin(event); if (block) return block;
 *     // ... rest of handler
 *   };
 */
function requireAdmin(event, cors = {}) {
  const headers = { 'Content-Type': 'application/json', ...cors };
  if (!getSigningSecret()) {
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'Admin auth not configured' }) };
  }
  if (!isAdminAuthed(event)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  return null;
}

module.exports = {
  TOKEN_TTL_MS,
  signAdminToken,
  verifyAdminToken,
  isAdminAuthed,
  requireAdmin,
  legacyKeyOk,
};
