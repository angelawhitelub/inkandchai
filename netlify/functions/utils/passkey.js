/**
 * Shared helpers for admin WebAuthn passkey endpoints.
 *
 * RP (Relying Party) is locked to inkandchai.in. Override via env:
 *   PASSKEY_RP_ID      (default 'inkandchai.in')
 *   PASSKEY_RP_ORIGIN  (default 'https://inkandchai.in')
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { isAdminAuthed, signAdminToken } = require('./admin-auth');

const RP_ID     = process.env.PASSKEY_RP_ID     || 'inkandchai.in';
const RP_ORIGIN = process.env.PASSKEY_RP_ORIGIN || 'https://inkandchai.in';
const RP_NAME   = 'Ink & Chai Admin';
const USERNAME  = 'admin';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;  // 5 minutes

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type':                 'application/json',
};

function supa() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function json(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

function preflight(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  return null;
}

// Accept either a valid X-Admin-Token (preferred, time-bounded) OR the
// legacy X-Admin-Key (ADMIN_SECRET / ADMIN_PASSWORD). All comparisons are
// constant-time via utils/admin-auth (and the inline ADMIN_PASSWORD branch
// below uses crypto.timingSafeEqual).
function adminAuthOk(event) {
  if (isAdminAuthed(event)) return true;
  const sent = (event.headers || {})['x-admin-key'] || (event.headers || {})['X-Admin-Key'] || '';
  if (!sent) return false;
  const password = process.env.ADMIN_PASSWORD || '';
  if (!password) return false;
  const a = Buffer.from(String(sent));
  const b = Buffer.from(password);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

// What we hand back to the browser after a successful passkey login.
//   • adminToken: signed, time-bounded — preferred for all new requests
//   • adminKey:   raw ADMIN_SECRET — kept for one transition release so
//                 already-deployed admin SPAs keep working until refresh
function adminSessionResponse() {
  return {
    adminToken: signAdminToken({ sub: 'admin' }),
    adminKey:   process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD || '',
  };
}

// Back-compat alias — older callers used this name. Returns ONLY the legacy
// key; new code should use adminSessionResponse() instead.
function adminSecretValue() {
  return process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD || '';
}

async function storeChallenge(sb, challenge, purpose) {
  await sb.from('webauthn_challenges').insert({ challenge, purpose, username: USERNAME });
}

// Consume a challenge — returns true if it was valid (existed + fresh).
async function consumeChallenge(sb, challenge, purpose) {
  const { data } = await sb
    .from('webauthn_challenges')
    .select('challenge, purpose, created_at')
    .eq('challenge', challenge)
    .maybeSingle();
  if (!data) return false;
  await sb.from('webauthn_challenges').delete().eq('challenge', challenge);
  if (data.purpose !== purpose) return false;
  const age = Date.now() - new Date(data.created_at).getTime();
  return age >= 0 && age <= CHALLENGE_TTL_MS;
}

module.exports = { RP_ID, RP_ORIGIN, RP_NAME, USERNAME, CORS, supa, json, preflight, adminAuthOk, adminSecretValue, adminSessionResponse, storeChallenge, consumeChallenge };
