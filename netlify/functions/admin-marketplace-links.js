/**
 * Netlify Function: admin-marketplace-links   (admin)
 *
 * The "You can also buy from our Amazon / Flipkart store" links of one book,
 * managed from the admin product editor.
 *
 *   GET  ?slug=…                                   → { links }  (or null)
 *   POST { slug, amazon_url, flipkart_url }        → { links }  blank clears that one
 *
 * Saving both blank removes the row, which removes the buttons.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { purgeUrls, purgeProductSlugs } = require('./utils/purge-cache');
const M = require('./utils/marketplace-links');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const MIGRATION = 'The product_marketplace_links table is missing — run sql/product_marketplace_links.sql in Supabase first.';

async function purgeLinks(slug) {
  const site = (process.env.SITE_URL || 'https://inkandchai.in').replace(/\/+$/, '');
  const [a, b] = await Promise.all([
    purgeUrls([`${site}/.netlify/functions/get-marketplace-links?slug=${encodeURIComponent(slug)}`]),
    purgeProductSlugs([slug]),
  ]);
  return !!(a && a.purged && b && b.purged);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return json(500, { error: 'Supabase is not configured.' });
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  if (event.httpMethod === 'GET') {
    const slug = M.cleanSlug((event.queryStringParameters || {}).slug);
    if (!slug) return json(400, { error: 'Missing product slug' });
    const { data, error } = await db.from(M.TABLE).select('*').eq('slug', slug).maybeSingle();
    if (error) return M.isMissingTable(error) ? json(200, { links: null, migration: MIGRATION }) : json(500, { error: error.message });
    return json(200, { links: M.publicLinks(data) });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const slug = M.cleanSlug(body.slug);
  if (!slug) return json(400, { error: 'Missing product slug' });

  const amazon = M.cleanStoreUrl('amazon', body.amazon_url);
  const flipkart = M.cleanStoreUrl('flipkart', body.flipkart_url);
  const bad = [amazon.error, flipkart.error].filter(Boolean);
  if (bad.length) return json(400, { error: bad.join(' ') });

  try {
    if (!amazon.url && !flipkart.url) {
      const { error } = await db.from(M.TABLE).delete().eq('slug', slug);
      if (error) return json(M.isMissingTable(error) ? 503 : 500, { error: M.isMissingTable(error) ? MIGRATION : error.message });
      return json(200, { links: null, cache_purged: await purgeLinks(slug) });
    }
    const row = { slug, amazon_url: amazon.url, flipkart_url: flipkart.url, updated_at: new Date().toISOString() };
    const { data, error } = await db.from(M.TABLE).upsert(row, { onConflict: 'slug' }).select().single();
    if (error) return json(M.isMissingTable(error) ? 503 : 500, { error: M.isMissingTable(error) ? MIGRATION : error.message });
    return json(200, { links: M.publicLinks(data), cache_purged: await purgeLinks(slug) });
  } catch (e) {
    console.error('[admin-marketplace-links]', e);
    return json(500, { error: e.message });
  }
};
