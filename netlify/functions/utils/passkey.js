/**
 * Shared helpers for admin WebAuthn passkey endpoints.
 *
 * RP (Relying Party) is locked to inkandchai.in. Override via env:
 *   PASSKEY_RP_ID      (default 'inkandchai.in')
 *   PASSKEY_RP_ORIGIN  (default 'https://inkandchai.in')
 */

const { createClient } = require('@supabase/supabase-js');

const RP_ID     = process.env.PASSKEY_RP_ID     || 'inkandchai.in';
const RP_ORIGIN = process.env.PASSKEY_RP_ORIGIN || 'https://inkandchai.in';
const RP_NAME   = 'Ink & Chai Admin';
const USERNAME  = 'admin';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;  // 5 minutes

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
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

// Compare the supplied admin key against ADMIN_SECRET / ADMIN_PASSWORD. This is
// only required for register-options (so a stranger can't enroll their own
// passkey). Login endpoints DO NOT need it — that would defeat the purpose.
function adminAuthOk(event) {
  const sent = event.headers['x-admin-key'] || event.headers['X-Admin-Key'] || '';
  const a = process.env.ADMIN_SECRET || '';
  const b = process.env.ADMIN_PASSWORD || '';
  return sent && (sent === a || sent === b);
}

function adminSecretValue() {
  // What we hand back to the browser after a successful passkey login — the
  // existing admin functions all gate on this value via X-Admin-Key.
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

module.exports = { RP_ID, RP_ORIGIN, RP_NAME, USERNAME, CORS, supa, json, preflight, adminAuthOk, adminSecretValue, storeChallenge, consumeChallenge };
