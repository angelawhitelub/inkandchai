/**
 * Ending a staff (limited admin) session at once.
 *
 * Admin tokens are signed and stateless, so a disabled staff login used to keep
 * working until its token expired -- up to 8 hours. Now disabling a login,
 * resetting its password, or the staff member changing their own password
 * stamps "revoked at" for that email in KV, and the Worker refuses every
 * function call made with a staff token issued at or before that moment
 * (worker/index.js, read with a 60 s edge cache, so within about a minute).
 *
 * Owner tokens and the legacy key are never looked at here.
 */

const STORE = 'admin';
const KEY = 'staff-revoked';
const KV_KEY = `${STORE}:${KEY}`;          // what the blobs shim writes in KV
const COOKIE = 'iac_admin_session';         // utils/admin-auth ADMIN_COOKIE_NAME

const store = () => require('@netlify/blobs').getStore(STORE);

function b64urlToText(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  if (typeof Buffer !== 'undefined') return Buffer.from(t, 'base64').toString('utf8');
  const bin = atob(t);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** The UNVERIFIED payload of an admin token. Only ever used to refuse, never to allow. */
function tokenClaims(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const p = JSON.parse(b64urlToText(parts[1]));
    return p && typeof p === 'object' ? p : null;
  } catch { return null; }
}

/** Every admin token a request carries (header and cookie). getHeader(name) -> string. */
function requestTokens(getHeader) {
  const out = [];
  const h = getHeader('x-admin-token');
  if (h) out.push(h);
  for (const part of String(getHeader('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) out.push(part.slice(i + 1).trim());
  }
  return out;
}

function staffEmail(claims) {
  if (!claims || !claims.role || claims.role === 'owner') return '';
  return String(claims.sub || '').replace(/^email:/, '').trim().toLowerCase();
}

/** True when this staff token was issued at or before the email's revocation. */
function isRevoked(claims, revokedMap) {
  const email = staffEmail(claims);
  if (!email || !revokedMap) return false;
  const at = Number(revokedMap[email]);
  return Number.isFinite(at) && at > 0 && Number(claims.iat || 0) <= at;
}

/** Worker side: the claims of the first revoked staff token sent, or null. */
function revokedStaffToken(tokens, revokedMap) {
  for (const t of tokens) {
    const c = tokenClaims(t);
    if (isRevoked(c, revokedMap)) return c;
  }
  return null;
}

async function readRevoked() {
  try { return (await store().get(KEY, { type: 'json' })) || {}; } catch { return {}; }
}

/** End every session of this staff email that exists now. */
async function revokeStaffSessions(email, now = Date.now()) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  const map = await readRevoked();
  map[e] = now;
  await store().setJSON(KEY, map);
  return true;
}

module.exports = {
  STORE, KEY, KV_KEY,
  tokenClaims, requestTokens, staffEmail, isRevoked, revokedStaffToken,
  readRevoked, revokeStaffSessions,
};
