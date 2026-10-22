/**
 * Netlify Function: admin-free-delivery   (admin)
 *
 * Switch free delivery on (or off) for one book (utils/free-delivery).
 *
 *   GET  ?slug=…                  → { free: bool }
 *   GET  (no slug)                → { slugs: [slug, …] }
 *   POST { slug, free_delivery }  → { free }   free_delivery false removes it
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { purgeProductSlugs } = require('./utils/purge-cache');
const { cleanSlug } = require('./utils/cod-rules');
const F = require('./utils/free-delivery');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const MIGRATION = 'The product_free_delivery table is missing — run sql/product_free_delivery.sql in Supabase first.';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return json(500, { error: 'Supabase is not configured.' });
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (event.httpMethod === 'GET') {
    const raw = (event.queryStringParameters || {}).slug;
    if (!raw) {
      try { return json(200, { slugs: await F.allFreeDelivery(db) }); }
      catch (e) { return json(500, { error: e.message }); }
    }
    const slug = cleanSlug(raw);
    if (!slug) return json(400, { error: 'Missing product slug' });
    const { data, error } = await db.from(F.TABLE).select('slug,updated_at').ilike('slug', slug).maybeSingle();
    if (error) return F.isMissingTable(error) ? json(200, { free: false, migration: MIGRATION }) : json(500, { error: error.message });
    return json(200, { free: !!data, updated_at: data ? data.updated_at : null });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const slug = cleanSlug(body.slug);
  if (!slug) return json(400, { error: 'Missing product slug' });

  const free = body.free_delivery === true;
  const { error } = free
    ? await db.from(F.TABLE).upsert({ slug, updated_at: new Date().toISOString() }, { onConflict: 'slug' })
    : await db.from(F.TABLE).delete().ilike('slug', slug);
  if (error) return json(F.isMissingTable(error) ? 409 : 500, { error: F.isMissingTable(error) ? MIGRATION : error.message });
  // The page badge comes from the Worker (≤1 min); purge the edge copy too.
  let purged = false;
  try { const r = await purgeProductSlugs([slug]); purged = !!(r && r.purged); } catch (e) { console.warn('[admin-free-delivery] purge:', e.message); }
  console.log(`[admin-free-delivery] ${slug} → free delivery ${free ? 'ON' : 'off'}`);
  return json(200, { free, cache_purged: purged });
};
