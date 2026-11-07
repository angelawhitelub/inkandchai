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
  if (!pdf) return { notFound: true, reason: `the label NimbusPost returned does not show AWB ${awb}` };
  return { pdf };
}

// TEMPORARY (2026-11-08): what NimbusPost's new label PDFs look like inside --
// operator counts and fonts only, no page text.
async function debugNimbus(awb) {
  const call = npV2.makeV2Caller({});
  const found = await npV2.findByAwb(call, awb);
  if (!found) return { found: false };
  const bytes = await npV2.labelPdf(call, [found.id]);
  const { PDFDocument, PDFName } = require('pdf-lib');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const raw = Buffer.from(bytes).toString('latin1');
  const pages = doc.getPages().map((p) => {
    let c = '';
    try { c = require('./utils/label-sort')._content ? '' : ''; } catch { /* none */ }
    const r = readPage(p);
    return { size: p.getSize(), texts: r.texts.length, awbLike: r.texts.filter((t) => /\d{8,}/.test(t.t)).map((t) => t.t.replace(/\D/g, '').slice(0, 4) + '…' + t.t.length) };
  });
  const count = (re) => (raw.match(re) || []).length;
  return {
    found: true, pageCount: doc.getPageCount(), bytes: bytes.length, pages,
    producer: (raw.match(/\/Producer\s*\(([^)]{0,60})\)/) || [])[1] || null,
    creator: (raw.match(/\/Creator\s*\(([^)]{0,60})\)/) || [])[1] || null,
    fonts: [...new Set((raw.match(/\/Subtype\s*\/(Type0|TrueType|Type1|Type3|CIDFontType2)/g) || []))],
    identityH: count(/Identity-H/g), toUnicode: count(/\/ToUnicode/g), flate: count(/FlateDecode/g),
    awbInRaw: raw.includes(awb), images: count(/\/Subtype\s*\/Image/g),
  };
}

const SOURCES = { xpressbees: xpressBeesLabel, nimbuspost: nimbusPostLabel };
const NAMES = { xpressbees: 'XpressBees', nimbuspost: 'NimbusPost' };

/** XpressBees first only when the order says XpressBees; NimbusPost books XpressBees too. */
const sourceOrder = (courier) => (/xpress\s*bees/i.test(String(courier || '')) ? ['xpressbees', 'nimbuspost'] : ['nimbuspost', 'xpressbees']);

async function findLabel(awb, courier, deps = {}) {
  const tried = [];
  for (const src of sourceOrder(courier)) {
    const got = await (deps.sources?.[src] || SOURCES[src])(awb, deps[src] || {});
    if (got.pdf) return { pdf: got.pdf, source: src };
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
    if (q.debug === 'np') return json(200, await debugNimbus(awb));   // TEMPORARY: label format check
    if (q.debug === 'nplist') {   // TEMPORARY: do list rows carry their own label link and items?
      const rows = await npV2.listOrders(npV2.makeV2Caller({}), { order_status: 'ready_to_ship', has_shipment: 'true' }, { max: 400 });
      const withUrl = rows.filter((r) => r.shipment && r.shipment.label_url);
      const host = (u) => { try { return new URL(u).host; } catch { return '?'; } };
      const it = rows.find((r) => Array.isArray(r.items) && r.items.length);
      return json(200, { rows: rows.length, with_label_url: withUrl.length,
        hosts: [...new Set(withUrl.map((r) => host(r.shipment.label_url)))].slice(0, 5),
        label_downloaded: rows.filter((r) => r.shipment && r.shipment.label_downloaded_at).length,
        item_keys: it ? Object.keys(it.items[0]).slice(0, 15) : null, order_number_sample: rows[0] ? String(rows[0].order_number || '').slice(0, 6) : null });
    }
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

exports._test = { pickLabelPage, xpressBeesLabel, nimbusPostLabel, findLabel, sourceOrder, cleanAwb };
