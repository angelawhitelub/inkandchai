/**
 * Owner endpoint: admin-order-label
 *
 * The shipping label of ONE order that already has an AWB -- for a lost or
 * torn label, or a reprint. Picked up or not.
 *
 *   GET ?awb=<AWB>&order=<order id, for the file name>&courier=<courier name>
 *       -> application/pdf (attachment), the single label page
 *       -> 404 { not_found: true } when neither panel has a label for that AWB
 *
 *   POST { orders: [{ awb, order, courier }, …] }   (up to 200; Not Picked Up → 🏷️ Labels)
 *       -> application/pdf: pick list, then every label found sorted by quantity
 *          and stamped like the bulk XpressBees button (utils/label-sort), then
 *          NimbusPost picture-only labels unstamped at the end. X-Label-Summary
 *          (URI-encoded JSON) lists the AWBs no courier had a label for.
 *       XpressBees AWBs go 50 at a time to the panel; whatever it does not have
 *       is asked of NimbusPost one by one. Does NOT mark anything downloaded
 *       (the "Latest dispatched" button's memory is left alone).
 *
 *   XpressBees  POST {UCP}/ship/assets/label { awbs: "<awb>" }   (panel API, any AWB on the account)
 *   NimbusPost  Partner API: GET /v2/orders?awb= -> order_id, then
 *               POST /v2/shipments/labels { order_ids: [id] }   (utils/nimbuspost-v2.js)
 * Which panel booked an order is not stored, so the likelier one (by courier
 * name) is asked first and the other second.
 *
 * Before anything is returned, the label page must show the requested AWB --
 * a wrong label would send a parcel to the wrong person.
 *
 * READ-ONLY at both couriers: nothing is booked, cancelled or changed.
 */

const { requireAdmin } = require('./utils/admin-auth');
const { readPage, buildSortedLabels } = require('./utils/label-sort');
const xbLabels = require('./admin-xpressbees-labels');
const npV2 = require('./utils/nimbuspost-v2');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Access-Control-Expose-Headers': 'Content-Disposition, X-Label-Source, X-Label-Summary',
};
const json = (statusCode, body) => ({
  statusCode, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body),
});

const cleanAwb = (s) => String(s || '').trim().toUpperCase();
const AWB_RE = /^[A-Z0-9]{6,30}$/;

/** The page that shows the AWB, as a one-page PDF; null when no page does. */
async function pickLabelPage(bytes, awb) {
  const { PDFDocument } = require('pdf-lib');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  const idx = pages.findIndex((p) => readPage(p).texts.some((t) => cleanAwb(t.t) === awb));
  if (idx < 0) return null;
  if (pages.length === 1) return bytes;
  const out = await PDFDocument.create();
  const [page] = await out.copyPages(doc, [idx]);
  out.addPage(page);
  return out.save();
}

/** One page that carries no text at all (a label drawn as a single picture). */
async function isSingleImagePage(bytes) {
  try {
    const { PDFDocument } = require('pdf-lib');
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    return doc.getPageCount() === 1 && readPage(doc.getPage(0)).texts.length === 0;
  } catch { return false; }
}

// 4 × 6 inch thermal label, in points.
const THERMAL_W = 288;
const THERMAL_H = 432;

/**
 * The label on a 4 × 6 page (owner, 8 Nov 2026). XpressBees answers a
 * one-order request with an A4 page, the label drawn in its top-left corner
 * (about 274 × 390 pt), which a thermal printer prints tiny or not at all.
 * The drawn area is found from the page's own lines, text and images, cropped,
 * and scaled to fit 4 × 6 (never enlarged past 1:1 more than the fit needs).
 * A page already 4 × 6 or smaller, or one whose drawing cannot be read, is
 * returned unchanged.
 */
async function fitToThermal(bytes) {
  const { PDFDocument } = require('pdf-lib');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  if (doc.getPageCount() !== 1) return bytes;
  const page = doc.getPage(0);
  const { width, height } = page.getSize();
  if (width <= THERMAL_W + 12 && height <= THERMAL_H + 12) return bytes;
  const r = readPage(page);
  const xs = [];
  const ys = [];
  for (const s of r.segs) { xs.push(s.x1, s.x2); ys.push(s.y1, s.y2); }
  for (const i of r.imgs) { xs.push(i.x, i.x + i.w); ys.push(i.y, i.y + i.h); }
  // Text gives its start only; its width is a guess, so it sets the sides only
  // when nothing is drawn (the frame lines and pictures are exact).
  const guessX = !xs.length;
  for (const t of r.texts) {
    ys.push(t.y, t.y + 10);
    if (guessX) xs.push(t.x, t.x + 4.5 * t.t.length);
    else xs.push(t.x);
  }
  if (xs.length < 4) return bytes;
  const pad = 3;
  const box = {
    left: Math.max(0, Math.min(...xs) - pad),
    right: Math.min(width, Math.max(...xs) + pad),
    bottom: Math.max(0, Math.min(r.contentBottom, ...ys) - pad),
    top: Math.min(height, Math.max(...ys) + pad),
  };
  const w = box.right - box.left;
  const h = box.top - box.bottom;
  if (w < 100 || h < 100) return bytes;
  const out = await PDFDocument.create();
  // The whole page is placed, scaled and shifted so the label's box lands
  // centred on the 4 × 6 page; the page edge does the cropping. (embedPage's
  // own bounding box clipped in the wrong place.)
  const embedded = await out.embedPage(page);
  const scale = Math.min(THERMAL_W / w, THERMAL_H / h);
  const label = out.addPage([THERMAL_W, THERMAL_H]);
  label.drawPage(embedded, {
    x: (THERMAL_W - w * scale) / 2 - box.left * scale,
    y: (THERMAL_H - h * scale) / 2 - box.bottom * scale,
    width: width * scale,
    height: height * scale,
  });
  return out.save();
}

async function xpressBeesLabel(awb, deps = {}) {
  const call = xbLabels.lib.makeCaller(deps);
  let bytes;
  try {
    bytes = await xbLabels.lib.labelPdf(call, [awb], deps.fetch || fetch);
  } catch (e) {
    // A refused login is a real failure; anything else means XpressBees has no label for it.
    if (/refused the API login/.test(String(e.message))) throw e;
    return { notFound: true, reason: String(e.message || e).slice(0, 200) };
  }
  const pdf = await pickLabelPage(bytes, awb).catch(() => null);
  if (!pdf) return { notFound: true, reason: `the label XpressBees returned does not show AWB ${awb}` };
  return { pdf };
}

async function nimbusPostLabel(awb, deps = {}) {
  if (!deps.v2Fetch && !npV2.configured()) return { notFound: true, reason: 'NimbusPost API key not set' };
  const call = npV2.makeV2Caller(deps);
  const found = await npV2.findByAwb(call, awb);
  if (!found) return { notFound: true, reason: 'AWB not found in NimbusPost' };
  const bytes = await npV2.labelPdf(call, [found.id], deps.fetch || fetch);
  const pdf = await pickLabelPage(bytes, awb).catch(() => null);
  if (pdf) return { pdf };
  // NimbusPost's new labels (Nov 2026) are one picture with no text, so the AWB
  // cannot be read off the page. Accept only that case: one page, no text, for
  // the order found by its exact AWB. A page WITH text must show the AWB.
  if (await isSingleImagePage(bytes)) return { pdf: bytes, imageOnly: true };
  return { notFound: true, reason: `the label NimbusPost returned does not show AWB ${awb}` };
}

const SOURCES = { xpressbees: xpressBeesLabel, nimbuspost: nimbusPostLabel };
const NAMES = { xpressbees: 'XpressBees', nimbuspost: 'NimbusPost' };

/** XpressBees first only when the order says XpressBees; NimbusPost books XpressBees too. */
const sourceOrder = (courier) => (/xpress\s*bees/i.test(String(courier || '')) ? ['xpressbees', 'nimbuspost'] : ['nimbuspost', 'xpressbees']);

async function findLabel(awb, courier, deps = {}) {
  const tried = [];
  for (const src of sourceOrder(courier)) {
    const got = await (deps.sources?.[src] || SOURCES[src])(awb, deps[src] || {});
    if (got.pdf) return { pdf: await fitToThermal(got.pdf).catch(() => got.pdf), source: src };
    tried.push(`${NAMES[src]}: ${got.reason}`);
  }
  return { tried };
}

const BULK_MAX = 200;
const XB_BATCH = 50;

/** Which of `awbs` some page of `bytes` shows. */
async function shownAwbs(bytes, awbs) {
  const { PDFDocument } = require('pdf-lib');
  const want = new Set(awbs);
  const seen = new Set();
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    for (const p of doc.getPages()) for (const t of readPage(p).texts) { const a = cleanAwb(t.t); if (want.has(a)) seen.add(a); }
  } catch { /* unreadable: nothing shown */ }
  return seen;
}

/** One sorted, stamped PDF for many orders' labels. Read-only at both couriers. */
async function bulkLabels(list, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const sources = [];
  const images = [];
  const missing = [];
  const rest = [];
  const xb = [];
  for (const x of list) (/xpress\s*bees/i.test(x.courier) ? xb : rest).push(x);

  if (xb.length) {
    const call = xbLabels.lib.makeCaller(deps.xpressbees || {});
    for (let i = 0; i < xb.length; i += XB_BATCH) {
      const chunk = xb.slice(i, i + XB_BATCH);
      const awbs = chunk.map((x) => x.awb);
      let bytes = null;
      try {
        bytes = await xbLabels.lib.labelPdf(call, awbs, fetchImpl, { returnShort: true, ...(deps.xbWaits ? { waits: deps.xbWaits } : {}) });
      } catch (e) {
        if (/refused the API login/.test(String(e.message))) throw e;
        console.warn('[order-label bulk] XpressBees batch', e.message);
      }
      const shown = bytes ? await shownAwbs(bytes, awbs) : new Set();
      const got = awbs.filter((a) => shown.has(a));
      if (got.length) sources.push({ bytes, awbs: got, sheets: true });
      for (const x of chunk) if (!shown.has(x.awb)) rest.push(x);   // NimbusPost books XpressBees too
    }
  }

  const npReady = !!deps.v2Fetch || npV2.configured();
  const npCall = npReady ? npV2.makeV2Caller(deps.nimbuspost || deps) : null;
  for (const x of rest) {
    if (!npCall) { missing.push({ awb: x.awb, order: x.order, reason: 'not in XpressBees; NimbusPost API key not set' }); continue; }
    try {
      const found = await npV2.findByAwb(npCall, x.awb);
      if (!found) { missing.push({ awb: x.awb, order: x.order, reason: 'not found in XpressBees or NimbusPost' }); continue; }
      const bytes = await npV2.labelPdf(npCall, [found.id], fetchImpl);
      const page = await pickLabelPage(bytes, x.awb).catch(() => null);
      if (page) sources.push({ bytes: page, awbs: [x.awb] });
      else if (await isSingleImagePage(bytes)) images.push({ ...x, bytes });
      else missing.push({ awb: x.awb, order: x.order, reason: 'NimbusPost label does not show this AWB' });
    } catch (e) {
      missing.push({ awb: x.awb, order: x.order, reason: String(e.message || e).slice(0, 160) });
    }
  }

  if (!sources.length && !images.length) return { missing };
  const { PDFDocument } = require('pdf-lib');
  let out;
  let summary = { labels: 0, units: 0, unread: [], unstamped: [] };
  if (sources.length) {
    const built = await buildSortedLabels(sources, { blank: false });
    out = await PDFDocument.load(built.pdf, { updateMetadata: false });
    summary = built.summary;
  } else {
    out = await PDFDocument.create();
  }
  for (const img of images) {
    const fitted = await fitToThermal(img.bytes).catch(() => img.bytes);
    const doc = await PDFDocument.load(fitted, { updateMetadata: false });
    const [pg] = await out.copyPages(doc, [0]);
    out.addPage(pg);
  }
  return {
    pdf: await out.save(),
    summary: { ...summary, image_only: images.map((x) => x.order || x.awb), missing },
  };
}

async function handleBulk(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const seen = new Set();
  const list = [];
  for (const o of Array.isArray(body.orders) ? body.orders : []) {
    const awb = cleanAwb(o && o.awb);
    if (!AWB_RE.test(awb) || seen.has(awb)) continue;
    seen.add(awb);
    list.push({ awb, order: String(o.order || '').replace(/[^\w-]/g, '').slice(0, 40), courier: String(o.courier || '').slice(0, 60) });
  }
  if (!list.length) return json(400, { error: 'No order with an AWB was selected' });
  if (list.length > BULK_MAX) return json(400, { error: `At most ${BULK_MAX} labels at a time (${list.length} selected)` });
  try {
    const got = await bulkLabels(list);
    if (!got.pdf) return json(404, { not_found: true, missing: got.missing, error: 'No courier had a label for any selected order.' });
    const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit' }).format(new Date()).replace('/', '');
    console.log(`[order-label bulk] asked=${list.length} labels=${got.summary.labels} images=${got.summary.image_only.length} missing=${got.summary.missing.length}`);
    return new Response(got.pdf, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="labels_not_picked_${list.length}_${day}.pdf"`,
        'Cache-Control': 'no-store, private',
        'X-Label-Summary': encodeURIComponent(JSON.stringify({ asked: list.length, ...got.summary })),
      },
    });
  } catch (e) {
    console.error('[order-label bulk]', e);
    return json(502, { error: e.message });
  }
}

exports.handler = async (event = {}) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS);
  if (block) return block;
  if (event.httpMethod === 'POST') return handleBulk(event);
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET or POST only' });

  const q = event.queryStringParameters || {};
  const awb = cleanAwb(q.awb);
  if (!AWB_RE.test(awb)) return json(400, { error: 'A valid AWB is required' });
  const order = String(q.order || '').replace(/[^\w-]/g, '').slice(0, 40);

  try {
    const got = await findLabel(awb, q.courier);
    if (!got.pdf) {
      console.warn('[order-label]', awb, JSON.stringify(got.tried));
      return json(404, { not_found: true, tried: got.tried,
        error: `No label for AWB ${awb} in XpressBees or NimbusPost. If DTDC or Delhivery booked it directly, download it from that courier.` });
    }
    return new Response(got.pdf, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="label_${order ? order + '_' : ''}${awb}.pdf"`,
        'Cache-Control': 'no-store, private',
        'X-Label-Source': got.source,
      },
    });
  } catch (e) {
    console.error('[order-label]', e);
    return json(502, { error: e.message });
  }
};

exports._test = { bulkLabels, handleBulk, shownAwbs, fitToThermal, isSingleImagePage, pickLabelPage, xpressBeesLabel, nimbusPostLabel, findLabel, sourceOrder, cleanAwb };
