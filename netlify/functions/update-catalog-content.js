/**
 * Netlify Function: update-catalog-content
 * Headers: X-Admin-Key / X-Admin-Token
 *
 * GET  ?slug=…   the feed's copy for a catalogue book, plus any saved override
 * POST { slug, description, author_bio, seo_title, meta_description, tags }
 *
 * Description, author bio, SEO title, meta description and tags for CATALOGUE
 * books -- the baked pages that have no custom_products row. Admin-created
 * listings keep saving through create-product-listing as before.
 *
 * Saving writes catalog_content, republishes it to KV, and purges the page from
 * the edge cache; the Worker applies it to the baked page from then on (within
 * about a minute). Blank fields mean "use the feed's text"; a save with nothing
 * that differs from the baked page deletes the override.
 *
 * Needs sql/catalog_content.sql.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { purgeProductSlugs } = require('./utils/purge-cache');
const {
  TABLE, FIELDS, MIGRATION, catalogueBook, overrideFor, publishContentIndex, feedCopy, normSlug,
} = require('./utils/catalog-content');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const missingTable = (e) => /catalog_content/.test(String(e && e.message || '')) && /exist|schema cache|relation/i.test(String(e.message));

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS); if (block) return block;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (event.httpMethod === 'GET') {
    const slug = normSlug((event.queryStringParameters || {}).slug);
    const book = catalogueBook(slug);
    if (!book) return json(404, { error: 'Not a catalogue book.' });
    const { data, error } = await supabase.from(TABLE).select('*').eq('slug', slug).maybeSingle();
    if (error && !missingTable(error)) return json(500, { error: error.message });
    return json(200, {
      feed: feedCopy(book, slug),
      override: error ? null : (data || null),
      ready: !error,
      ...(error ? { warning: `Run ${MIGRATION} before saving catalogue copy.` } : {}),
    });
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const slug = normSlug(body.slug);
  const book = catalogueBook(slug);
  if (!book) return json(404, { error: 'Not a catalogue book — admin-created listings save through Create Listing.' });

  const row = overrideFor(book, body);
  let saved = null;
  if (row) {
    const { data, error } = await supabase.from(TABLE)
      .upsert({ slug, ...row, updated_at: new Date().toISOString() }, { onConflict: 'slug' })
      .select('*').maybeSingle();
    if (error) return json(missingTable(error) ? 503 : 500, { error: missingTable(error) ? `Run ${MIGRATION} first.` : error.message });
    saved = data;
  } else {
    const { error } = await supabase.from(TABLE).delete().eq('slug', slug);
    if (error) return json(missingTable(error) ? 503 : 500, { error: missingTable(error) ? `Run ${MIGRATION} first.` : error.message });
  }

  const index = await publishContentIndex(supabase);
  const cache = await purgeProductSlugs([slug]).catch(() => ({ purged: false }));
  return json(200, {
    success: true,
    slug,
    override: saved,
    reverted: !row,
    fields: saved ? FIELDS.filter((f) => saved[f]) : [],
    published: index.ok,
    publish_error: index.ok ? null : index.error,
    cache_purged: cache.purged !== false,
  });
};
