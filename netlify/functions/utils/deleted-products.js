/**
 * Deleted product pages — the list, and the KV mirror the Worker reads.
 *
 * Catalogue books are baked static files under public/product/<slug>/, so
 * "delete" cannot mean removing a database row: there is no row. What it means
 * is that the Worker must refuse to serve the file. wrangler.toml puts
 * /product/* in run_worker_first, so worker/index.js gets the request BEFORE
 * the asset router and can answer 410 Gone instead of calling ASSETS.fetch().
 *
 * Supabase is the record (deleted_products) and Workers KV is the read path:
 * the Worker cannot query Supabase on every product view, so every write here
 * re-publishes the whole slug list to one KV key. The list is small — this is
 * a hand-curated set of takedowns, not a bulk channel — so a full rewrite is
 * simpler and cannot drift the way incremental patches do.
 *
 * 410 rather than 404 on purpose: 404 means "might come back", and Google
 * re-crawls it for months. 410 means gone, and it drops out of the index in
 * days. Anything genuinely temporary belongs in Remove From Sale
 * (restore-listing), which keeps the page live and shows "Coming Soon".
 */
const { getStore } = require('@netlify/blobs');

// worker/shims/netlify-blobs.js maps this to KV key `catalog:deleted-products`,
// which is what worker/index.js reads. Changing either name breaks the other.
const STORE = 'catalog';
const KEY = 'deleted-products';
const KV_KEY = `${STORE}:${KEY}`;

const normSlug = (s) => String(s || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '').slice(0, 200);

/**
 * Every deleted slug, newest first. Returns { slugs, rows, ok } — ok is false
 * when the table has not been created yet, so callers can say so rather than
 * reporting an empty list as success.
 */
async function readDeleted(supabase) {
  const { data, error } = await supabase
    .from('deleted_products')
    .select('slug,title,kind,reason,deleted_at')
    .order('deleted_at', { ascending: false });
  if (error) return { slugs: [], rows: [], ok: false, error: error.message };
  const rows = data || [];
  return { slugs: rows.map(r => normSlug(r.slug)).filter(Boolean), rows, ok: true };
}

/**
 * Re-publish the list to KV so the Worker starts refusing those URLs. Failing
 * here means the page keeps serving, so callers surface the result instead of
 * reporting a delete that only half happened.
 */
async function publishDeletedIndex(supabase) {
  const { slugs, ok, error } = await readDeleted(supabase);
  if (!ok) return { published: false, reason: error || 'table-missing', slugs: [] };
  try {
    await getStore(STORE).setJSON(KEY, { slugs, updated_at: new Date().toISOString() });
    return { published: true, slugs };
  } catch (err) {
    return { published: false, reason: err.message, slugs };
  }
}

module.exports = { readDeleted, publishDeletedIndex, normSlug, STORE, KEY, KV_KEY };
