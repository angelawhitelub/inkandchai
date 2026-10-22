/**
 * Netlify Function: admin-cod-rules   (admin)
 *
 * Switch Cash on Delivery off (or back on) for one book, with the reason the
 * customer reads. Partial COD and prepaid stay available (utils/cod-rules).
 *
 *   GET  ?slug=…                          → { rule: { slug, note } | null, default_note }
 *   GET  (no slug)                        → { rules: { slug: note }, default_note }
 *   POST { slug, cod_disabled, note }     → { rule }   cod_disabled false removes it
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { purgeProductSlugs } = require('./utils/purge-cache');
const C = require('./utils/cod-rules');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const MIGRATION = 'The product_cod_rules table is missing — run sql/product_cod_rules.sql in Supabase first.';

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
      try { return json(200, { rules: await C.allCodRules(db), default_note: C.DEFAULT_NOTE }); }
      catch (e) { return json(500, { error: e.message }); }
    }
    const slug = C.cleanSlug(raw);
    if (!slug) return json(400, { error: 'Missing product slug' });
    const { data, error } = await db.from(C.TABLE).select('slug,note,updated_at').ilike('slug', slug).maybeSingle();
    if (error) return C.isMissingTable(error) ? json(200, { rule: null, default_note: C.DEFAULT_NOTE, migration: MIGRATION }) : json(500, { error: error.message });
    return json(200, { rule: data ? { slug: data.slug, note: C.cleanNote(data.note), updated_at: data.updated_at } : null, default_note: C.DEFAULT_NOTE });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const slug = C.cleanSlug(body.slug);
  if (!slug) return json(400, { error: 'Missing product slug' });

  let rule = null;
  if (body.cod_disabled === true) {
    const { data, error } = await db.from(C.TABLE)
      .upsert({ slug, note: C.cleanNote(body.note) || null, updated_at: new Date().toISOString() }, { onConflict: 'slug' })
      .select('slug,note,updated_at').single();
    if (error) return json(C.isMissingTable(error) ? 409 : 500, { error: C.isMissingTable(error) ? MIGRATION : error.message });
    rule = { slug: data.slug, note: C.cleanNote(data.note), updated_at: data.updated_at };
  } else {
    const { error } = await db.from(C.TABLE).delete().ilike('slug', slug);
    if (error) return json(C.isMissingTable(error) ? 409 : 500, { error: C.isMissingTable(error) ? MIGRATION : error.message });
  }
  // The page notice comes from the Worker (≤1 min); purge the edge copy too.
  let purged = false;
  try { const r = await purgeProductSlugs([slug]); purged = !!(r && r.purged); } catch (e) { console.warn('[admin-cod-rules] purge:', e.message); }
  console.log(`[admin-cod-rules] ${slug} → COD ${rule ? 'OFF' : 'on'}`);
  return json(200, { rule, default_note: C.DEFAULT_NOTE, cache_purged: purged });
};
