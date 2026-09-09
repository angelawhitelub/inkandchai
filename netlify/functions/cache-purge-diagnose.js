/**
 * Netlify Function: cache-purge-diagnose
 * GET /.netlify/functions/cache-purge-diagnose
 *
 * Admin — why is the cache purge failing? purgeUrls() only ever reports
 * `http-404`, which is the same answer for a zone that does not exist, a zone
 * the token cannot see, and a malformed identifier. Cloudflare distinguishes
 * them in the response body, so this asks it and hands back the error codes.
 *
 * A Worker secret cannot be read back, so this describes the secrets without
 * revealing them: length, shape, stray whitespace, a pasted "Bearer " prefix,
 * and whether CF_ZONE_ID has been confused with the account id.
 *
 * CF_ZONE_ID being unset is the RECOMMENDED setup, not a fault: purge-cache
 * resolves the zone from SITE_URL's host when the token carries Zone: Read,
 * which is one fewer hand-typed 32-hex string to get wrong. So an empty zone
 * id is resolved here the same way and then actually exercised.
 *
 * Headers: X-Admin-Token / X-Admin-Key.
 */

const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Admin-Key',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};
const json = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj, null, 2) });

const HEX32 = /^[0-9a-f]{32}$/;
const c6111 = (e) => e && e.code === 6111;
// Optional: set CF_ACCOUNT_ID to catch the account-id-in-the-zone-id mixup.
const ACCOUNT_ID = String(process.env.CF_ACCOUNT_ID || '').trim();

async function cf(path, token, init = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
      signal: ctl.signal,
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, errors: body.errors || [], result: body.result };
  } catch (err) {
    return { status: 0, ok: false, errors: [{ message: ctl.signal.aborted ? 'timeout' : err.message }] };
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;

  const rawZone = process.env.CF_ZONE_ID || '';
  const zone = rawZone.trim();
  const token = process.env.CF_PURGE_TOKEN || '';
  const site = (process.env.SITE_URL || 'https://inkandchai.in').replace(/\/+$/, '');
  const host = new URL(site).host;

  // Describe, never reveal.
  const config = {
    zone_id_set: Boolean(rawZone),
    zone_id_length: rawZone.length,
    zone_id_is_32_hex: HEX32.test(zone),
    zone_id_has_surrounding_whitespace: rawZone !== zone,
    zone_id_is_actually_the_account_id: Boolean(ACCOUNT_ID) && zone === ACCOUNT_ID,
    purge_token_set: Boolean(token),
    // The zone lookup can fail with "Invalid format for Authorization header",
    // which is a fault in the TOKEN, not the zone. Describe its shape so that
    // is diagnosable without anyone reading the value: a Cloudflare API token
    // is 40 characters of [A-Za-z0-9_-], and the usual damage is a trailing
    // newline from a paste or a "Bearer " prefix pasted along with it.
    purge_token_length: token.length,
    purge_token_has_surrounding_whitespace: token !== token.trim(),
    purge_token_has_inner_whitespace: /\s/.test(token.trim()),
    purge_token_has_bearer_prefix: /^bearer\s/i.test(token.trim()),
    purge_token_is_cf_token_shape: /^[A-Za-z0-9_.-]{30,120}$/.test(token.trim()),
    site_url: site,
  };

  if (!token) return json(200, { config, verdict: 'CF_PURGE_TOKEN is not set — purging is disabled.' });

  // Look the zone up first: with no CF_ZONE_ID that is the only way to get one,
  // and with a wrong CF_ZONE_ID it is what purge-cache falls back to.
  const lookupFirst = await cf(`/zones?name=${encodeURIComponent(host)}`, token);
  const foundFirst = Array.isArray(lookupFirst.result) ? lookupFirst.result[0] : null;
  const effectiveZone = zone || (foundFirst && foundFirst.id) || '';
  if (!effectiveZone) {
    return json(200, {
      config,
      zone_lookup: { status: lookupFirst.status, ok: lookupFirst.ok, errors: lookupFirst.errors, correct_zone_id: null },
      verdict: 'No CF_ZONE_ID, and the token cannot look the zone up by name — add Zone: Read to the token, or set CF_ZONE_ID.',
    });
  }

  // 1. What does the purge endpoint actually say? Purge one URL that exists, so
  //    a success here is a real success and not a quirk of an empty request.
  const purge = await cf(`/zones/${encodeURIComponent(effectiveZone)}/purge_cache`, token, {
    method: 'POST',
    body: JSON.stringify({ files: [`${site}/`] }),
  });

  // 2. Can the token see the zone by name? If yes, the correct id is one lookup
  //    away and nobody has to go find it in the dashboard.
  const lookup = lookupFirst;
  const found = foundFirst;

  let verdict;
  if (purge.ok && !zone) verdict = 'Purge works. CF_ZONE_ID is unset and the zone is resolved by name — the recommended setup.';
  else if (purge.ok) verdict = 'Purge works. CF_ZONE_ID and CF_PURGE_TOKEN are correct.';
  else if (config.zone_id_is_actually_the_account_id) verdict = 'CF_ZONE_ID holds the ACCOUNT id, not the zone id. They are both 32-hex and easy to mix up.';
  else if (!config.zone_id_is_32_hex) verdict = 'CF_ZONE_ID is not a 32-character hex string, so it cannot be a zone id.';
  else if (found && found.id !== zone) verdict = `CF_ZONE_ID does not match the real zone for ${host}. The correct id is in correct_zone_id below.`;
  else if (lookup.errors.some(e => (e.error_chain || []).some(c => c.code === 6111) || c6111(e))) verdict = 'CF_PURGE_TOKEN itself is malformed — Cloudflare rejects the Authorization header before checking permissions.';
  else if (purge.status === 403) verdict = 'The zone id looks right; CF_PURGE_TOKEN lacks Cache Purge: Edit on this zone.';
  else verdict = 'Zone id is well-formed but Cloudflare will not route to it — the token probably cannot see this zone.';

  return json(200, {
    config,
    purge_attempt: { status: purge.status, ok: purge.ok, errors: purge.errors },
    zone_lookup: {
      status: lookup.status,
      ok: lookup.ok,
      errors: lookup.errors,
      // Not a secret: a zone id is a public identifier shown on the dashboard
      // overview page. Printing it is the entire point of this endpoint.
      correct_zone_id: found ? found.id : null,
      zone_name: found ? found.name : null,
      matches_configured: found && zone ? found.id === zone : null,
      zone_id_source: zone ? 'CF_ZONE_ID' : 'resolved from SITE_URL host',
    },
    verdict,
  });
};
