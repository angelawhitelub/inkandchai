/**
 * Netlify Function: delete-product
 * POST /.netlify/functions/delete-product   { slug, reason?, undo? }
 *
 * Admin — permanently take a product page down. Two kinds of product, one
 * button, because from the admin's side there is no useful difference:
 *
 *   CUSTOM listing (custom_products, shopify_id "CUSTOM:...")
 *     The row IS the page — product-page.js renders it on demand. Deleting the
 *     row deletes the page. Not reversible: nothing is left to restore from.
 *
 *   CATALOGUE book (baked static file, public/product/<slug>/index.html)
 *     There is no row to delete. Instead the slug is recorded in
 *     deleted_products and mirrored to KV, and worker/index.js answers 410 Gone
 *     for it before the asset router ever sees the request — wrangler.toml puts
 *     /product/* in run_worker_first precisely so the Worker can do this. The
 *     file stays on disk, unreachable, until the next site regeneration drops
 *     it (generate_site.py reads data/deleted_products.json). Reversible: undo
 *     removes the record and the page serves again.
 *
 * This used to 409 on catalogue books and tell the admin to hand-edit a
 * redirect. That was wrong — it read run_worker_first backwards.
 *
 * "Delete" is for titles that should never come back. For a temporary
 * out-of-stock use Remove From Sale (restore-listing), which keeps the page and
 * its ranking and swaps Add to Cart for "Coming Soon".
 *
 * Headers: X-Admin-Token / X-Admin-Key.
 */

const { createClient } = require('@supabase/supabase-js');
const { purgeProductSlugs } = require('./utils/purge-cache');
const { requireAdmin } = require('./utils/admin-auth');
const { publishDeletedIndex, normSlug } = require('./utils/deleted-products');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Admin-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const json = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });

// Told to the admin verbatim when deleted_products is missing, so the fix is
// one copy-paste away instead of a 500 with a Postgres error code in it.
const MIGRATION_HINT =
  'The deleted_products table does not exist yet. Run the migration in ' +
  'sql/deleted_products.sql (Supabase → SQL Editor), then try again.';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return json(405, { error: 'Method Not Allowed' });

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Supabase env vars missing' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const slug = normSlug(body.slug);
  if (!slug) return json(400, { error: 'Provide product slug' });
  const undo = body.undo === true;
  const reason = String(body.reason || '').slice(0, 500) || null;

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // ── Undo ───────────────────────────────────────────────────────────────
    // Only meaningful for a catalogue book: its file was never removed, so
    // dropping the record puts the page straight back. A custom listing's row
    // is gone, so there is nothing to serve and we say so rather than pretending.
    if (undo) {
      const { data: rec, error: recErr } = await supabase
        .from('deleted_products').select('slug,kind,title').ilike('slug', slug).maybeSingle();
      if (recErr) return json(500, { error: recErr.message.includes('deleted_products') ? MIGRATION_HINT : recErr.message });
      if (!rec) return json(404, { error: 'That slug is not in the deleted list.' });
      if (rec.kind === 'custom') {
        return json(409, {
          error: 'This was an admin-created listing — its row was deleted, so there is nothing to restore. Create the listing again.',
          kind: 'custom',
        });
      }
      const { error: delErr } = await supabase.from('deleted_products').delete().ilike('slug', slug);
      if (delErr) throw delErr;
      const index = await publishDeletedIndex(supabase);
      const cache = await purgeProductSlugs([slug]);
      return json(200, {
        success: true, restored: true, slug, title: rec.title || '',
        index_published: index.published, index_reason: index.reason || null,
        cache_purged: cache.purged, deleted_count: (index.slugs || []).length,
      });
    }

    // ── Which kind is this? ────────────────────────────────────────────────
    // Match case-insensitively: stored slugs may carry an upper-case suffix
    // while the URL slug is lower-case.
    const { data: found, error: findErr } = await supabase
      .from('custom_products')
      .select('slug, title')
      .ilike('slug', slug)
      .limit(1)
      .maybeSingle();
    if (findErr) throw findErr;

    const kind = found ? 'custom' : 'catalogue';
    const realSlug = found ? normSlug(found.slug) : slug;
    let title = found ? (found.title || '') : '';

    if (found) {
      // The row is the page: deleting it is what makes the URL stop resolving.
      const del = await supabase.from('custom_products').delete().eq('slug', found.slug);
      if (del.error) throw del.error;
      // Best-effort: drop any override row so a stale price/title can't linger.
      try { await supabase.from('product_overrides').delete().ilike('slug', realSlug); } catch { /* non-fatal */ }
    } else {
      // A catalogue book has no row anywhere; the title is only in the baked
      // file. Take whatever the admin sent so the deleted list stays readable.
      title = String(body.title || '').slice(0, 300);
    }

    // Record the takedown for BOTH kinds. For a catalogue book this is the
    // whole mechanism. For a custom listing it is what keeps the slug 410 —
    // otherwise the URL would 404 forever as a "might come back", and it also
    // stops a re-import from silently resurrecting a title that was pulled.
    const { error: recErr } = await supabase
      .from('deleted_products')
      .upsert({ slug: realSlug, title: title || null, kind, reason }, { onConflict: 'slug' });
    if (recErr) {
      // The custom row is already gone at this point, so report precisely:
      // the page is down, but the takedown is not recorded and will not 410.
      const missing = /relation .*deleted_products.* does not exist|schema cache/i.test(recErr.message);
      return json(missing && kind === 'catalogue' ? 400 : 500, {
        error: missing ? MIGRATION_HINT : recErr.message,
        deleted_row: kind === 'custom',
      });
    }

    const index = await publishDeletedIndex(supabase);
    const cache = await purgeProductSlugs([realSlug]);

    return json(200, {
      success: true, slug: realSlug, title, kind,
      index_published: index.published, index_reason: index.reason || null,
      deleted_count: (index.slugs || []).length,
      cache_purged: cache.purged, cache_reason: cache.reason || null,
    });
  } catch (err) {
    console.error('delete-product error:', err.message);
    const missing = /relation .*deleted_products.* does not exist|schema cache/i.test(err.message || '');
    return json(missing ? 400 : 500, { error: missing ? MIGRATION_HINT : err.message });
  }
};
