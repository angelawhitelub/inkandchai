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
 * NimbusPost Partner API (utils/nimbuspost-v2.js), since NimbusPost moved to
 * app.nimbuspost.com in Nov 2026 (the old ship.nimbuspost.com/mapi panel
 * endpoints stopped answering):
 *   GET  /v2/orders?order_status=ready_to_ship&has_shipment=true   (the Pickups tab)
 *   POST /v2/shipments/labels { order_ids: [...] } -> { data: { url } } one merged PDF
 * label-sort matches every page to the AWB printed on it and refuses to build
 * if a page shows none of the requested AWBs.
 *
 * READ-ONLY at NimbusPost: nothing is booked, cancelled or scheduled.
 */

const { requireAdmin } = require('./utils/admin-auth');
const v2 = require('./utils/nimbuspost-v2');
const { buildSortedLabels } = require('./utils/label-sort');

const READY = 'ready_to_ship';
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

const NpError = v2.NpV2Error;
const makeCaller = (deps = {}) => v2.makeV2Caller(deps);

/** Every booked order in the Pickups tab, oldest first. */
async function readyShipments(call) {
  const rows = await v2.listOrders(call, { order_status: READY, has_shipment: 'true' }, { max: MAX_LABELS });
  const seen = new Set();
  return rows.map(v2.toShipment).filter((r) => {
    if (!r.awb_number || !r.id || seen.has(r.awb_number)) return false;
    // The list is filtered server-side; this guards against the filter being ignored.
    if (r.ship_status && r.ship_status !== READY) return false;
    seen.add(r.awb_number);
    return true;
  }).sort((a, b) => String(a.created).localeCompare(String(b.created)));
}

async function labelPdf(call, shipments, fetchImpl = fetch) {
  return v2.labelPdf(call, shipments.map((r) => r.id), fetchImpl);
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

exports._test = { run, readyShipments, makeCaller, labelPdf, istDate, READY };
