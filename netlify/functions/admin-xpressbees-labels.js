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
 *   ?scope=latest  only labels not downloaded before (the fresh batch);
 *   ?scope=all     every label waiting for pickup (the default).
 *   Every PDF built here, either scope, records its AWBs as downloaded (KV
 *   DOWNLOADED_KEY, kept 45 days), so the next "latest" starts after it. An
 *   unreadable list reads as empty: "latest" then gives everything, never less.
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

// Lazy: the runtime shim is Worker-only and tests pass their own kv.
const defaultKv = () => { try { return require('../../worker/shims/runtime-bindings').get('ORDER_FALLBACK'); } catch { return null; } };
const DOWNLOADED_KEY = 'xb-labels-downloaded:v1';
const KEEP_DAYS = 45;

/** { awb: iso time downloaded } from KV, pruned. A fault reads as empty. */
async function readDownloaded(kv) {
  if (!kv) return {};
  try {
    const raw = await kv.get(DOWNLOADED_KEY);
    const all = raw ? JSON.parse(raw) : {};
    const cutoff = Date.now() - KEEP_DAYS * 86400e3;
    return Object.fromEntries(Object.entries(all).filter(([, at]) => Date.parse(at) > cutoff));
  } catch (e) {
    console.warn('[xb-labels] downloaded list unreadable:', e.message);
    return {};
  }
}

async function markDownloaded(kv, seen, awbs) {
  if (!kv) return false;
  const at = new Date().toISOString();
  for (const a of awbs) seen[a] = at;
  await kv.put(DOWNLOADED_KEY, JSON.stringify(seen), { expirationTtl: KEEP_DAYS * 86400 });
  return true;
}

const UCP = 'https://xb-ucp-wallet-api-uat.xbees.in/api/v1';   // production, despite the name
const READY = 'pending pickup,pickup reattempt,awaiting scan';
const PAGE = 100;
const CHUNK = 50;
// The panel's own bulk download stops at 500; this has no practical cap.
// 2,120 labels built in ~3 s CPU under an 80 MB heap (measured 14 Nov 2026).
// Hitting the cap is an error, never a silent cut: a missing label is a
// parcel nobody packs.
const MAX_LABELS = 3000;
// Label batches asked of XpressBees at once. One: XpressBees hands back the
// PDF link before it has finished writing the file, and three at a time made
// a part-written download (13 pages of 50) likely on 14 Nov 2026.
const PARALLEL = 1;
// A short or unreadable label PDF is fetched again after these waits (ms),
// then the batch is asked for once more with the same waits.
const SETTLE_WAITS = [1500, 3000, 5000, 8000];
// Labels of shipments not yet picked up come from the panel's S3 (xbees.in);
// already-shipped ones from shipment.xpressbees.com/assets.
const LABEL_HOST = /^https:\/\/([\w-]+\.)*(xbees\.in|xpressbees\.com)\//;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Access-Control-Expose-Headers': 'Content-Disposition, X-Label-Count, X-Label-Units, X-Label-Mixed, X-Label-Unread, X-Label-Reverse-Skipped',
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

/**
 * Reverse pickups (customer returns) sit in the same Ready to Pickup tab but
 * are collected from the customer, not packed here. The panel marks them
 * order_payment_type "REVERSE" with order ids "R-…" (19 of 1,194 on 14 Nov
 * 2026, every one carrying both marks); either one leaves the label out.
 */
const isReverse = (r) => String(r.order_payment_type || '').toUpperCase() === 'REVERSE' || /^R-/i.test(String(r.order_id || ''));

/** Every forward shipment in the Ready to Pickup tab (reverse pickups left out). */
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
    if (page === Math.ceil(MAX_LABELS / PAGE)) {
      throw new XbError(`More than ${MAX_LABELS} XpressBees shipments are waiting for pickup — too many for one PDF. Ask for a shorter period (?days=).`, 413);
    }
  }
  const seen = new Set();
  const out = rows.filter((r) => {
    const awb = String(r.awb_number || '').trim();
    if (!awb || seen.has(awb) || isReverse(r)) return false;
    seen.add(awb);
    return true;
  });
  out.reverseSkipped = new Set(rows.filter(isReverse).map((r) => String(r.awb_number || '').trim())).size;
  return out;
}

/** Pages in a PDF, or 0 when it cannot be read (e.g. still being written). */
async function pageCount(bytes) {
  try {
    const { PDFDocument } = require('pdf-lib');
    return (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
  } catch { return 0; }
}

/**
 * One merged label PDF for `awbs`, with one page per AWB. XpressBees returns
 * the link before the file is complete, so a download with too few pages (or
 * a broken one) is fetched again after a wait, and if it stays short the
 * batch is requested afresh once. Still short after that is an error.
 */
async function labelPdf(call, awbs, fetchImpl = fetch, { waits = SETTLE_WAITS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last = 0;
  for (let ask = 0; ask < 2; ask++) {
    const out = await call('/ship/assets/label', { method: 'POST', body: { awbs: awbs.join(',') }, ms: 60000 });
    const url = out.data?.data;
    if (out.httpStatus !== 200 || out.data?.status !== true || typeof url !== 'string' || !LABEL_HOST.test(url)) {
      throw new XbError(`XpressBees label download failed (HTTP ${out.httpStatus}): ${out.data?.message || out.raw}`, 502);
    }
    for (let i = 0; i <= waits.length; i++) {
      if (i) await sleep(waits[i - 1]);
      const res = await fetchImpl(url);
      if (!res.ok) {
        if (res.status === 403 || res.status === 404) { last = 0; continue; }   // not there yet
        throw new XbError(`Label PDF download failed (HTTP ${res.status})`, 502);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      last = await pageCount(bytes);
      if (last === awbs.length) return bytes;
      if (last > awbs.length) return bytes;   // label-sort refuses it with the exact counts
    }
    console.warn(`[xb-labels] batch of ${awbs.length} still ${last} pages after waiting${ask ? '' : '; asking again'}`);
  }
  throw new XbError(`XpressBees returned ${last} label pages for ${awbs.length} AWBs even after waiting and asking again; nothing was built. Try again in a few minutes.`, 502);
}

const istDate = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.month}${p.day}`;
};

/** `only(awb)`, when given, keeps just those AWBs (the WhatsApp send skips ones already sent). */
async function run({ days = 30, summaryOnly = false, only = null } = {}, deps = {}) {
  const call = makeCaller(deps);
  const shipments = await readyShipments(call, { days });
  const ready = shipments.map((r) => String(r.awb_number).trim());
  const awbs = only ? ready.filter(only) : ready;
  if (summaryOnly || !awbs.length) return { awbs, ready, shipments, reverseSkipped: shipments.reverseSkipped || 0 };

  const chunks = [];
  for (let i = 0; i < awbs.length; i += CHUNK) chunks.push(awbs.slice(i, i + CHUNK));
  const sources = new Array(chunks.length);
  for (let i = 0; i < chunks.length; i += PARALLEL) {
    await Promise.all(chunks.slice(i, i + PARALLEL).map(async (chunk, k) => {
      sources[i + k] = { bytes: await labelPdf(call, chunk, deps.fetch || fetch), awbs: chunk };
    }));
  }
  const built = await buildSortedLabels(sources, { date: new Date() });
  return { awbs, ready, shipments, reverseSkipped: shipments.reverseSkipped || 0, ...built };
}

async function handle(event = {}, deps = {}) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS);
  if (block) return block;
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });

  const q = event.queryStringParameters || {};
  const days = Math.min(90, Math.max(1, parseInt(q.days, 10) || 30));
  const latest = q.scope === 'latest';
  const scope = latest ? 'latest' : 'all';
  const kv = 'kv' in deps ? deps.kv : defaultKv();
  try {
    const seen = await readDownloaded(kv);
    const only = latest ? (awb) => !seen[awb] : null;
    if (q.format === 'json') {
      const { awbs, ready, shipments, reverseSkipped } = await run({ days, summaryOnly: true, only }, deps);
      const want = new Set(awbs);
      const byStatus = {};
      for (const r of shipments) {
        if (!want.has(String(r.awb_number).trim())) continue;
        byStatus[r.ship_status || '?'] = (byStatus[r.ship_status || '?'] || 0) + 1;
      }
      return json(200, { success: true, scope, labels: awbs.length, ready: ready.length, downloaded_before: ready.length - awbs.length, reverse_skipped: reverseSkipped, by_status: byStatus, days });
    }
    const out = await run({ days, only }, deps);
    if (!out.awbs.length) {
      return json(200, { success: true, scope, labels: 0, ready: out.ready.length,
        message: latest && out.ready.length
          ? `No new XpressBees labels since the last download. ${out.ready.length} are still waiting for pickup; use "All ready to pickup" to print them again.`
          : `No XpressBees shipments are waiting for pickup (last ${days} days).` });
    }
    const s = out.summary;
    console.log('[xb-labels]', scope, JSON.stringify(s));
    try { await markDownloaded(kv, seen, out.awbs); } catch (e) { console.warn('[xb-labels] mark downloaded:', e.message); }
    return new Response(out.pdf, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="xpressbees_labels_${latest ? 'latest_' : ''}${s.labels}_sorted_${istDate()}.pdf"`,
        'Cache-Control': 'no-store, private',
        'X-Label-Count': String(s.labels),
        'X-Label-Units': String(s.units),
        'X-Label-Mixed': String(s.mixed),
        'X-Label-Unread': String(s.unread.length),
        'X-Label-Reverse-Skipped': String(out.reverseSkipped || 0),
      },
    });
  } catch (e) {
    console.error('[xb-labels]', e);
    return json(e instanceof XbError ? e.status : 500, { error: e.message });
  }
}

// The Worker passes its own context as the second argument; tests use handle().
exports.handler = (event) => handle(event, {});

exports._test = { run, readyShipments, isReverse, makeCaller, istDate, UCP, readDownloaded, DOWNLOADED_KEY, handle };
// Shared with admin-order-label.js (one order's label).
exports.lib = { makeCaller, labelPdf, XbError, pageCount };
