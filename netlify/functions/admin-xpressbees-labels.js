/**
 * Owner endpoint: admin-xpressbees-labels
 *
 * Every XpressBees shipment waiting for pickup, as ONE label PDF sorted for
 * packing (utils/label-sort.js): pick list first, single-title orders grouped
 * by book with the biggest quantities first, mixed orders after, each label
 * stamped with its book names and "#N of M", and a blank page last.
 *
 *   GET            the sorted PDF (attachment)
 *   GET ?format=json   only the summary: how many labels / books, nothing built
 *   ?days=N        how far back to look for pending shipments (default 30, max 90)
 *
 * The public XpressBees API has no label download. These are the panel's own
 * endpoints (the "Ready to Pickup" tab and its bulk "Download Label"), called
 * with the API login token:
 *   GET  {UCP}/shipment/list?ship_status_in=pending pickup,…   100 per page
 *   POST {UCP}/ship/assets/label  { awbs: "a,b,c" }  -> { data: <S3 url of a PDF> }
 * The label PDF has one page per AWB in request order; label-sort checks that
 * against the AWB printed on each page and refuses to build if they disagree.
 *
 * READ-ONLY at XpressBees: nothing is booked, cancelled or changed.
 */

const { requireAdmin } = require('./utils/admin-auth');
const xb = require('./utils/xpressbees');
const { buildSortedLabels } = require('./utils/label-sort');

const UCP = 'https://xb-ucp-wallet-api-uat.xbees.in/api/v1';   // production, despite the name
const READY = 'pending pickup,pickup reattempt,awaiting scan';
const PAGE = 100;
const CHUNK = 50;
const MAX_LABELS = 1000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Access-Control-Expose-Headers': 'Content-Disposition, X-Label-Count, X-Label-Units, X-Label-Mixed, X-Label-Unread',
};
const json = (statusCode, body) => ({
  statusCode, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body),
});

class XbError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function ucpFetch(path, { token, method = 'GET', body, ms = 30000, fetchImpl = fetch } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetchImpl(`${UCP}${path}`, {
      method,
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
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

/** ucpFetch with the API login token, re-logging in once on a 401. */
function makeCaller(deps) {
  const login = deps.login || xb.login;
  const call = deps.ucpFetch || ucpFetch;
  return async (path, opts = {}) => {
    let out = await call(path, { ...opts, token: await login() });
    if (out.httpStatus === 401 || out.httpStatus === 403) out = await call(path, { ...opts, token: await login({ force: true }) });
    if (out.httpStatus === 401 || out.httpStatus === 403) {
      throw new XbError(`The XpressBees panel API refused the API login (HTTP ${out.httpStatus}). `
        + 'The XPRESSBEES_EMAIL login works for booking but not for panel labels — download them from the panel instead.', 502);
    }
    return out;
  };
}

/** Every shipment in the Ready to Pickup tab, oldest first (the panel's own order is newest first). */
async function readyShipments(call, { days }) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 24 * 60 * 60;
  const rows = [];
  for (let page = 1; page <= Math.ceil(MAX_LABELS / PAGE); page++) {
    const qs = new URLSearchParams({ limit: String(PAGE), page: String(page), ship_status_in: READY, start_date: String(start), end_date: String(end) });
    const out = await call(`/shipment/list?${qs}`);
    const recs = out.data?.data?.records;
    if (out.httpStatus !== 200 || !Array.isArray(recs)) {
      throw new XbError(`XpressBees shipment list failed (HTTP ${out.httpStatus}): ${out.data?.message || out.raw}`, 502);
    }
    rows.push(...recs);
    if (recs.length < PAGE) break;
  }
  const seen = new Set();
  return rows.filter((r) => {
    const awb = String(r.awb_number || '').trim();
    if (!awb || seen.has(awb)) return false;
    seen.add(awb);
    return true;
  });
}

async function labelPdf(call, awbs, fetchImpl = fetch) {
  const out = await call('/ship/assets/label', { method: 'POST', body: { awbs: awbs.join(',') }, ms: 60000 });
  const url = out.data?.data;
  if (out.httpStatus !== 200 || out.data?.status !== true || typeof url !== 'string' || !/^https:\/\/[\w.-]+\.xbees\.in\//.test(url)) {
    throw new XbError(`XpressBees label download failed (HTTP ${out.httpStatus}): ${out.data?.message || out.raw}`, 502);
  }
  const res = await fetchImpl(url);
  if (!res.ok) throw new XbError(`Label PDF download failed (HTTP ${res.status})`, 502);
  return new Uint8Array(await res.arrayBuffer());
}

const istDate = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.month}${p.day}`;
};

async function run({ days = 30, summaryOnly = false } = {}, deps = {}) {
  const call = makeCaller(deps);
  const shipments = await readyShipments(call, { days });
  const awbs = shipments.map((r) => String(r.awb_number).trim());
  if (summaryOnly || !awbs.length) return { awbs, shipments };

  const sources = [];
  for (let i = 0; i < awbs.length; i += CHUNK) {
    const chunk = awbs.slice(i, i + CHUNK);
    sources.push({ bytes: await labelPdf(call, chunk, deps.fetch || fetch), awbs: chunk });
  }
  const built = await buildSortedLabels(sources, { date: new Date() });
  return { awbs, shipments, ...built };
}

exports.handler = async (event = {}) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS);
  if (block) return block;
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });

  const q = event.queryStringParameters || {};
  const days = Math.min(90, Math.max(1, parseInt(q.days, 10) || 30));
  try {
    if (q.format === 'json') {
      const { awbs, shipments } = await run({ days, summaryOnly: true });
      const byStatus = {};
      for (const r of shipments) byStatus[r.ship_status || '?'] = (byStatus[r.ship_status || '?'] || 0) + 1;
      return json(200, { success: true, labels: awbs.length, by_status: byStatus, days });
    }
    const out = await run({ days });
    if (!out.awbs.length) return json(200, { success: true, labels: 0, message: `No XpressBees shipments are waiting for pickup (last ${days} days).` });
    const s = out.summary;
    console.log('[xb-labels]', JSON.stringify(s));
    return new Response(out.pdf, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="xpressbees_labels_${s.labels}_sorted_${istDate()}.pdf"`,
        'Cache-Control': 'no-store, private',
        'X-Label-Count': String(s.labels),
        'X-Label-Units': String(s.units),
        'X-Label-Mixed': String(s.mixed),
        'X-Label-Unread': String(s.unread.length),
      },
    });
  } catch (e) {
    console.error('[xb-labels]', e);
    return json(e instanceof XbError ? e.status : 500, { error: e.message });
  }
};

exports._test = { run, readyShipments, makeCaller, istDate, UCP };
