/**
 * Netlify Function: admin-order-report-pdf
 * POST { title, orders: [{ id, date, customer, pay, items: [{ title, slug, qty }] }] }
 *   → { ok, filename, pdf (base64), summary }
 *
 * Admin Orders → "Unshipped report (PDF)" / "Selected orders report (PDF)".
 * The page sends the orders it already has (unshipped, or the ticked ones);
 * this only lays them out: books most copies first, then the orders. Nothing
 * is read from or written to the database, so staff with order access may use
 * it (admin-auth STAFF_ENDPOINT_PERMISSIONS: orders.read).
 */

const { requireAdmin } = require('./utils/admin-auth');
const { buildOrderReportPdf, MAX_ORDERS } = require('./utils/order-report-pdf');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Admin-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });

async function handle(event, { skipAuth = false, now = () => new Date() } = {}) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  if (!skipAuth) { const block = requireAdmin(event, CORS); if (block) return block; }
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const orders = Array.isArray(body.orders) ? body.orders : [];
  if (!orders.length) return json(400, { error: 'No orders to report.' });
  if (orders.length > MAX_ORDERS) return json(400, { error: `At most ${MAX_ORDERS} orders per report.` });
  const title = String(body.title || 'Orders report').replace(/[^\w &().,'-]/g, '').slice(0, 80) || 'Orders report';
  try {
    const at = now();
    const { bytes, summary } = await buildOrderReportPdf({ title, orders, generatedAt: at });
    const day = at.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const filename = `inkandchai-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${day}.pdf`;
    return json(200, { ok: true, filename, pdf: Buffer.from(bytes).toString('base64'), summary });
  } catch (e) {
    console.error('[admin-order-report-pdf]', e.message);
    return json(500, { error: e.message });
  }
}

exports.handler = (event) => handle(event);
exports.handle = handle;
