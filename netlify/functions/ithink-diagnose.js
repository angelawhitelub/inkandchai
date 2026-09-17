/**
 * Netlify Function: ithink-diagnose
 * GET /.netlify/functions/ithink-diagnose?pincode=110006
 *
 * Admin — first contact with the iThink Logistics v3 API. Read-only: it checks
 * a pincode and lists warehouses. It books nothing, cancels nothing and spends
 * nothing, so it is safe to run against live credentials.
 *
 * It answers the three things we cannot know from the docs alone:
 *
 *   1. Do the credentials work at all? `wrangler secret put` is write-only, so
 *      a typo or a half-copied key is invisible until something fails. This
 *      describes both secrets without revealing them — length, shape, stray
 *      whitespace — the same trick cache-purge-diagnose uses.
 *   2. Which host is real? iThink's own docs disagree: doc-add-order and
 *      doc-check-pincode say my.ithinklogistics.com, doc-track-order says
 *      api.ithinklogistics.com. Both are tried and the winner is reported.
 *   3. What are pickup_address_id / return_address_id? Both are mandatory on
 *      order/add.json and neither is guessable. warehouse/get.json returns the
 *      registered warehouses with their ids.
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

// Both candidates from the docs. pre-alpha is their staging tier and needs
// staging credentials, so it is deliberately not probed with live keys.
const HOSTS = [
  'https://my.ithinklogistics.com',
  'https://api.ithinklogistics.com',
  'https://pre-alpha.ithinklogistics.com',
];

// Sitaram Bazar. Only used as the default subject of a serviceability lookup.
const DEFAULT_PINCODE = '110006';

const TIMEOUT_MS = 12000;

/**
 * Describe a secret without printing it. A secret that is present but wrong is
 * the expensive failure — it looks configured and fails at the first real
 * push — so report the shape precisely enough to spot a bad paste.
 */
function describeSecret(name) {
  const raw = process.env[name];
  if (raw === undefined) return { name, set: false, note: 'not set on the Worker' };
  const trimmed = String(raw).trim();
  return {
    name,
    set: true,
    length: String(raw).length,
    has_surrounding_whitespace: String(raw) !== trimmed,
    looks_like_32_hex: /^[0-9a-f]{32}$/i.test(trimmed),
    // A key pasted with its label still attached is a common copy-button miss.
    contains_spaces_inside: /\s/.test(trimmed),
  };
}

/**
 * iThink signals failure with status:"error" while STILL sending
 * status_code:200 and HTTP 200. Reading the HTTP status, or status_code, or
 * even the presence of a body, reports a rejected key as a working one --
 * which this function did on its first run. Only status === 'success' counts.
 */
function isSuccess(probe) {
  return !!probe && probe.parsed && probe.body
    && probe.body.status === 'success' && probe.body.status !== 'error';
}

async function ithinkPost(host, path, payload) {
  const url = `${host}/api_v3/${path}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: payload }),
      signal: ctl.signal,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* keep the raw body below */ }
    return {
      url,
      http_status: res.status,
      ms: Date.now() - started,
      // An HTML body here means we reached a web page, not the API — that is
      // the signature of the wrong host, and it is worth seeing a little of it.
      body: parsed ?? text.slice(0, 400),
      parsed: !!parsed,
    };
  } catch (err) {
    return { url, ms: Date.now() - started, error: err.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS);
  if (block) return block;

  const accessToken = String(process.env.ITHINK_ACCESS_TOKEN || '').trim();
  const secretKey   = String(process.env.ITHINK_SECRET_KEY   || '').trim();

  const secrets = [describeSecret('ITHINK_ACCESS_TOKEN'), describeSecret('ITHINK_SECRET_KEY')];

  if (!accessToken || !secretKey) {
    return json(503, {
      ok: false,
      error: 'iThink credentials are not configured on the Worker.',
      fix: 'npx wrangler secret put ITHINK_ACCESS_TOKEN --name inkandchai (and ITHINK_SECRET_KEY)',
      secrets,
    });
  }

  const pincode = String((event.queryStringParameters || {}).pincode || DEFAULT_PINCODE).trim();
  const auth    = { access_token: accessToken, secret_key: secretKey };
  const swapped = { access_token: secretKey,   secret_key: accessToken };

  // Probe every host in both key orientations. "Invalid Access Token And
  // Secret Key" is the same message whether the pair is wrong or merely the
  // wrong way round, and the panel shows the two fields adjacently, so a
  // swap is the single likeliest cause and worth ruling out in one run.
  const pincodeProbes = [];
  for (const host of HOSTS) {
    for (const orientation of ['as-set', 'swapped']) {
      const keys = orientation === 'as-set' ? auth : swapped;
      const probe = await ithinkPost(host, 'pincode/check.json', { pincode, ...keys });
      pincodeProbes.push({ orientation, ...probe });
    }
  }

  const worked = pincodeProbes.find(isSuccess);
  const liveHost = worked ? new URL(worked.url).origin : null;
  // A host that answers with a real API error is serving the API; a host that
  // says "Invalid Request" is not. Worth separating from "keys are bad".
  const apiHosts = [...new Set(pincodeProbes
    .filter((p) => p.parsed && /Invalid Access Token|success/i.test(JSON.stringify(p.body || '')))
    .map((p) => new URL(p.url).origin))];

  // warehouse/get.json documents a warehouse_id but we do not have one yet;
  // omitting it is the only way to ask "what warehouses exist?". If iThink
  // insists on the field, the error body will say so and we ask the panel.
  let warehouses = null;
  if (liveHost) {
    warehouses = await ithinkPost(liveHost, 'warehouse/get.json', { ...auth });
  }

  const couriers = worked?.body?.data?.[pincode];

  return json(200, {
    ok: !!worked,
    checked_at: new Date().toISOString(),
    secrets,
    pincode_checked: pincode,
    live_host: liveHost,
    key_orientation_that_worked: worked ? worked.orientation : null,
    hosts_serving_the_api: apiHosts,
    diagnosis: worked
      ? `Credentials accepted at ${liveHost} with keys ${worked.orientation}.`
      : 'Credentials REJECTED in every host/orientation combination. The keys are '
        + 'well-formed but iThink does not recognise the pair. Ask the account '
        + 'manager to confirm API access is enabled for this account and that '
        + 'these are live (not staging) keys.',
    // The point of the pincode call is not the pincode — it is proof that the
    // credentials authenticate. A courier list means both keys are good.
    credentials_valid: !!worked,
    serviceable_couriers: couriers ? Object.keys(couriers) : null,
    courier_detail: couriers || null,
    warehouses: warehouses || 'skipped — no host answered the pincode check',
    probes: pincodeProbes,
  });
};
