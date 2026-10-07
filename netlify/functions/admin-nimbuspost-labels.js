/**
 * Owner endpoint: admin-nimbuspost-labels
 *
 * Every NimbusPost shipment waiting for pickup, as ONE label PDF sorted for
 * packing -- the same build as admin-xpressbees-labels.js (utils/label-sort.js):
 * pick list first, single-title orders grouped by book with the biggest
 * quantities first, mixed orders after, each label stamped with its book names
 * and "#N of M", and a blank page last.
 *
 *   GET                the sorted PDF (attachment)
 *   GET ?format=json   only the summary: how many labels, by courier, nothing built
 *
 * The public NimbusPost API has no bulk label download. These are the seller
 * panel's own endpoints (the "Waiting for Pickup" tab and its "Print Label"),
 * called with the API login token:
 *   POST {MAPI}/shipment/list?limit=100&page=N  { ship_status_in: 'pending pickup' }
 *   POST {MAPI}/pricing/get-third-party-response
 *        { url: 'api/Ivr/generate_label', shipping_ids: [<shipment id>, …] }
 *        -> { status: true, data: <S3 url of one merged PDF> }
 * label-sort matches every page to the AWB printed on it and refuses to build
 * if a page shows none of the requested AWBs.
 *
 * READ-ONLY at NimbusPost: nothing is booked, cancelled or scheduled.
 */

const { requireAdmin } = require('./utils/admin-auth');
const { npAuthenticate } = require('./utils/nimbuspost-cancel');
const { buildSortedLabels } = require('./utils/label-sort');

const MAPI = 'https://ship.nimbuspost.com/mapi/v1';
const READY = 'pending pickup';
const PAGE = 100;
const CHUNK = 50;
const MAX_LABELS = 1000;
const LABEL_URL = /^https:\/\/nimubs-assets\.s3\.amazonaws\.com\//;   // sic: NimbusPost's bucket name

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Access-Control-Expose-Headers': 'Content-Disposition, X-Label-Count, X-Label-Units, X-Label-Mixed, X-Label-Unread',
};
const json = (statusCode, body) => ({
  statusCode, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body),
});

class NpError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function mapiFetch(path, { token, body, ms = 30000, fetchImpl = fetch } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetchImpl(`${MAPI}${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* raw below */ }
    return { httpStatus: res.status, data, raw: text.slice(0, 300) };
  } catch (e) {
    if (e.name === 'AbortError') return { httpStatus: 599, data: null, raw: `timed out after ${Math.round(ms / 1000)}s` };
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** mapiFetch with the API login token, logging in again once on a 401/403. */
function makeCaller(deps) {
  const login = deps.login || npAuthenticate;
  const call = deps.mapiFetch || mapiFetch;
  let token = null;
  return async (path, opts = {}) => {
    if (!token) token = await login();
    let out = await call(path, { ...opts, token });
    if (out.httpStatus === 401 || out.httpStatus === 403) {
      token = await login();
      out = await call(path, { ...opts, token });
    }
    if (out.httpStatus === 401 || out.httpStatus === 403) {
      throw new NpError(`The NimbusPost panel API refused the API login (HTTP ${out.httpStatus}). `
        + 'Download the labels from the NimbusPost panel instead.', 502);
    }
    return out;
  };
}

/** Every shipment in the Waiting for Pickup tab, oldest first (the panel lists newest first). */
async function readyShipments(call) {
  const rows = [];
  for (let page = 1; page <= Math.ceil(MAX_LABELS / PAGE); page++) {
    const out = await call(`/shipment/list?limit=${PAGE}&page=${page}`, { body: { ship_status_in: READY, applied_tags: '' } });
    const recs = out.data?.data?.records;
    if (out.httpStatus !== 200 || !Array.isArray(recs)) {
      throw new NpError(`NimbusPost shipment list failed (HTTP ${out.httpStatus}): ${out.data?.message || out.raw}`, 502);
    }
    rows.push(...recs);
    if (recs.length < PAGE) break;
  }
  const seen = new Set();
  return rows.filter((r) => {
    const awb = String(r.awb_number || '').trim();
    if (!awb || !r.id || seen.has(awb)) return false;
    // The list is filtered server-side; this guards against the filter being ignored.
    if (String(r.ship_status || '').toLowerCase() !== READY) return false;
    seen.add(awb);
    return true;
  }).reverse();
}

async function labelPdf(call, shipments, fetchImpl = fetch) {
  const out = await call('/pricing/get-third-party-response', {
    body: { url: 'api/Ivr/generate_label', shipping_ids: shipments.map((r) => String(r.id)) }, ms: 60000,
  });
  const url = out.data?.data;
  if (out.httpStatus !== 200 || out.data?.status !== true || typeof url !== 'string' || !LABEL_URL.test(url)) {
    throw new NpError(`NimbusPost label download failed (HTTP ${out.httpStatus}): ${out.data?.message || out.raw}`, 502);
  }
  const res = await fetchImpl(url);
  if (!res.ok) throw new NpError(`Label PDF download failed (HTTP ${res.status})`, 502);
  return new Uint8Array(await res.arrayBuffer());
}

const istDate = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.month}${p.day}`;
};

/** `only(awb)`, when given, keeps just those AWBs (the WhatsApp send skips ones already sent). */
async function run({ summaryOnly = false, only = null } = {}, deps = {}) {
  const call = makeCaller(deps);
  const shipments = await readyShipments(call);
  const ready = shipments.map((r) => String(r.awb_number).trim());
  const picked = only ? shipments.filter((r) => only(String(r.awb_number).trim())) : shipments;
  const awbs = picked.map((r) => String(r.awb_number).trim());
  if (summaryOnly || !awbs.length) return { awbs, ready, shipments };

  const sources = [];
  for (let i = 0; i < picked.length; i += CHUNK) {
    const chunk = picked.slice(i, i + CHUNK);
    sources.push({ bytes: await labelPdf(call, chunk, deps.fetch || fetch), awbs: chunk.map((r) => String(r.awb_number).trim()) });
  }
  const built = await buildSortedLabels(sources, { date: new Date() });
  return { awbs, ready, shipments, ...built };
}

exports.handler = async (event = {}) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS);
  if (block) return block;
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });

  const q = event.queryStringParameters || {};
  try {
    if (q.format === 'json') {
      const { awbs, shipments } = await run({ summaryOnly: true });
      const byCourier = {};
      for (const r of shipments) byCourier[r.courier_name || '?'] = (byCourier[r.courier_name || '?'] || 0) + 1;
      return json(200, { success: true, labels: awbs.length, by_courier: byCourier });
    }
    const out = await run();
    if (!out.awbs.length) return json(200, { success: true, labels: 0, message: 'No NimbusPost shipments are waiting for pickup.' });
    const s = out.summary;
    console.log('[np-labels]', JSON.stringify(s));
    return new Response(out.pdf, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="nimbuspost_labels_${s.labels}_sorted_${istDate()}.pdf"`,
        'Cache-Control': 'no-store, private',
        'X-Label-Count': String(s.labels),
        'X-Label-Units': String(s.units),
        'X-Label-Mixed': String(s.mixed),
        'X-Label-Unread': String(s.unread.length),
      },
    });
  } catch (e) {
    console.error('[np-labels]', e);
    return json(e instanceof NpError ? e.status : 500, { error: e.message });
  }
};

exports._test = { run, readyShipments, makeCaller, labelPdf, istDate, MAPI };
