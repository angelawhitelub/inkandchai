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
const { readPage } = require('./utils/label-sort');
const xbLabels = require('./admin-xpressbees-labels');
const npV2 = require('./utils/nimbuspost-v2');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Access-Control-Expose-Headers': 'Content-Disposition, X-Label-Source',
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

exports.handler = async (event = {}) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS);
  if (block) return block;
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });

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

exports._test = { fitToThermal, isSingleImagePage, pickLabelPage, xpressBeesLabel, nimbusPostLabel, findLabel, sourceOrder, cleanAwb };
