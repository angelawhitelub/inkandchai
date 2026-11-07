/**
 * Owner endpoint: admin-order-label
 *
 * The XpressBees shipping label of ONE order that already has an AWB -- for a
 * lost or torn label, or a reprint.
 *
 *   GET ?awb=<AWB>&order=<order id, for the file name>
 *       -> application/pdf (attachment), the single label page
 *       -> 404 { not_found: true } when XpressBees has no label for that AWB
 *
 * Same panel endpoint as the bulk sorted-label button, which takes any AWB on
 * the account, picked up or not:
 *   POST {UCP}/ship/assets/label { awbs: "<awb>" } -> S3 url of the PDF
 *
 * NimbusPost is not here: its new panel (app.nimbuspost.com, Nov 2026) signs
 * in with the browser session only, and the old mapi endpoints time out. The
 * admin button opens that panel searched to the AWB instead.
 *
 * Before anything is returned, the label page must show the requested AWB --
 * a wrong label would send a parcel to the wrong person.
 *
 * READ-ONLY at XpressBees: nothing is booked, cancelled or changed.
 */

const { requireAdmin } = require('./utils/admin-auth');
const { readPage } = require('./utils/label-sort');
const xbLabels = require('./admin-xpressbees-labels');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Access-Control-Expose-Headers': 'Content-Disposition',
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
    const got = await xpressBeesLabel(awb);
    if (!got.pdf) {
      console.warn('[order-label]', awb, got.reason);
      return json(404, { not_found: true, error: `XpressBees has no label for AWB ${awb} (${got.reason}).` });
    }
    return new Response(got.pdf, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="label_${order ? order + '_' : ''}${awb}.pdf"`,
        'Cache-Control': 'no-store, private',
      },
    });
  } catch (e) {
    console.error('[order-label]', e);
    return json(502, { error: e.message });
  }
};

exports._test = { pickLabelPage, xpressBeesLabel, cleanAwb };
