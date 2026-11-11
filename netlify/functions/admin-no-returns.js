/**
 * Netlify Function: admin-no-returns   (admin)
 *
 * Stock clearance books: no returns, only replacements (utils/no-returns).
 *   GET  ?slug=…              → { slug, on, since }
 *   GET                       → { items: [{ slug, title, since, updated_at }] }
 *   POST { slug, on, title? } → { slug, on, since }
 *
 * Binds orders placed from the moment it is switched on; earlier buyers keep
 * their 7-day return. Checkout and returns read it within a minute.
 */

const { requireAdmin } = require('./utils/admin-auth');
const NR = require('./utils/no-returns');
const { normSlug } = require('./utils/product-id');

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
      const items = await NR.readList();
      const raw = (event.queryStringParameters || {}).slug;
      if (!raw) return json(200, { items });
      const slug = normSlug(raw);
      if (!slug) return json(400, { error: 'Missing product slug' });
      const hit = items.find((i) => i.slug === slug);
      return json(200, { slug, on: !!hit, since: hit ? hit.since : null });
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const slug = normSlug(body.slug);
    if (!slug) return json(400, { error: 'Missing product slug' });
    const items = await NR.setNoReturns(slug, body.on === true, { title: body.title });
    const hit = items.find((i) => i.slug === slug);
    console.log(`[admin-no-returns] ${slug} → ${hit ? 'no returns (clearance)' : 'returns allowed'}`);
    return json(200, { slug, on: !!hit, since: hit ? hit.since : null });
  } catch (e) {
    console.error('[admin-no-returns]', e);
    return json(500, { error: e.message });
  }
};
