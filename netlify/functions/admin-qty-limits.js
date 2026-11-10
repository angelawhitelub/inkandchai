/**
 * Netlify Function: admin-qty-limits   (admin)
 *
 * Most copies of a book one order may hold (utils/qty-limits).
 *   GET  ?slug=…            → { slug, max, product_id }
 *   GET                     → { items: [{ slug, max, title, updated_at, product_id }] }
 *   POST { slug, max, title? }   max = 1–999, or null/'' to remove → { slug, max, product_id }
 *
 * Checkout reads the limit through pricing within a minute (isolate cache);
 * the cart and product page read /qty-limits.json (5-minute browser cache).
 */

const { requireAdmin } = require('./utils/admin-auth');
const L = require('./utils/qty-limits');
const { productId, normSlug } = require('./utils/product-id');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;
  try {
    if (event.httpMethod === 'GET') {
      const items = (await L.readLimits()).map((i) => ({ ...i, product_id: productId(i.slug) }));
      const raw = (event.queryStringParameters || {}).slug;
      if (!raw) return json(200, { items });
      const slug = normSlug(raw);
      if (!slug) return json(400, { error: 'Missing product slug' });
      const hit = items.find((i) => i.slug === slug);
      return json(200, { slug, max: hit ? hit.max : null, product_id: productId(slug) });
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const slug = normSlug(body.slug);
    if (!slug) return json(400, { error: 'Missing product slug' });
    try { await L.setLimit(slug, body.max, { title: body.title }); }
    catch (e) { return json(400, { error: e.message }); }
    const max = (await L.limitMap())[slug] || null;
    console.log(`[admin-qty-limits] ${slug} → ${max ? `max ${max} per order` : 'no limit'}`);
    return json(200, { slug, max, product_id: productId(slug) });
  } catch (e) {
    console.error('[admin-qty-limits]', e);
    return json(500, { error: e.message });
  }
};
