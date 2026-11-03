/**
 * Netlify Function: admin-search-hidden   (admin)
 *
 * Hide one book from the site search, or show it again (utils/search-hidden).
 * The book stays on sale: only search stops returning it.
 *
 *   GET  ?slug=…                    → { hidden: bool, hidden_at }
 *   GET  (no slug)                  → { items: [{ slug, title, hidden_at }, …] }
 *   POST { slug, hidden, title? }   → { hidden, cache_purged }
 */

const { requireAdmin } = require('./utils/admin-auth');
const { purgeCacheTags } = require('./utils/purge-cache');
const H = require('./utils/search-hidden');

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
      const items = await H.readHidden();
      const raw = (event.queryStringParameters || {}).slug;
      if (!raw) return json(200, { items });
      const slug = H.normSlug(raw);
      if (!slug) return json(400, { error: 'Missing product slug' });
      const hit = items.find((i) => i.slug === slug);
      return json(200, { hidden: !!hit, hidden_at: hit ? hit.hidden_at : null });
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const slug = H.normSlug(body.slug);
    if (!slug) return json(400, { error: 'Missing product slug' });
    const hidden = body.hidden === true;
    await H.setHidden(slug, hidden, { title: body.title });

    // The homepage search reads get-product-overrides; purge it so the change
    // shows at once. Suggestions carry a query string and cannot be purged,
    // so those catch up within the Worker's 5-minute cap on them.
    let purged = false;
    try { const r = await purgeCacheTags(['product-overrides']); purged = !!(r && r.purged); }
    catch (e) { console.warn('[admin-search-hidden] purge:', e.message); }
    console.log(`[admin-search-hidden] ${slug} → ${hidden ? 'hidden from' : 'back in'} search`);
    return json(200, { hidden, cache_purged: purged });
  } catch (e) {
    console.error('[admin-search-hidden]', e);
    return json(500, { error: e.message });
  }
};
