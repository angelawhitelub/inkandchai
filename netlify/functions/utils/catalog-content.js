/**
 * Admin-written copy for CATALOGUE books -- the baked pages from
 * data/ALL_BOOKS.json, which have no custom_products row to hold it.
 *
 * Supabase (catalog_content) is the record. Workers KV is the read path: after
 * every save the whole table is published to one key, which the Worker reads
 * once a minute and applies to the baked page as it is served (see
 * utils/catalog-content-render.js). Same shape as utils/deleted-products.js.
 *
 * The table is small by nature -- one row per book someone has actually
 * rewritten -- so republishing all of it is simpler and safer than patching.
 *
 * Needs sql/catalog_content.sql.
 */

'use strict';

const { makeSlug } = require('./pricing');
const { catalogueFeedId } = require('./feed-id');
const CATALOGUE = require('../../../data/ALL_BOOKS.json');

const TABLE = 'catalog_content';
const STORE = 'catalog';
const KEY = 'content-overrides';          // KV key `catalog:content-overrides`
const LIMITS = { description: 5000, author_bio: 3000, seo_title: 150, meta_description: 320, tags: 600 };
const FIELDS = Object.keys(LIMITS);
const MIGRATION = 'sql/catalog_content.sql';

const normSlug = (s) => String(s || '').trim().toLowerCase();

let _bySlug = null;
/** The catalogue book behind a slug, or null when it is not a catalogue book. */
function catalogueBook(slug) {
  if (!_bySlug) {
    _bySlug = new Map();
    for (const b of Array.isArray(CATALOGUE) ? CATALOGUE : []) {
      const sid = String(b.shopify_id || '');
      if (!sid || !b.title) continue;
      const s = normSlug(makeSlug(b.title, sid));
      if (!_bySlug.has(s)) _bySlug.set(s, b);
    }
  }
  return _bySlug.get(normSlug(slug)) || null;
}

/** Keep the admin's line breaks (they are formatting); trim and cap each field. */
function cleanFields(body = {}) {
  const out = {};
  for (const f of FIELDS) {
    const raw = String(body[f] == null ? '' : body[f]).replace(/\r\n?/g, '\n');
    const v = (f === 'description' || f === 'author_bio' ? raw.trim() : raw.replace(/\s+/g, ' ').trim()).slice(0, LIMITS[f]);
    out[f] = v || null;
  }
  return out;
}

/**
 * What to store for this book. A description identical to the feed's is not an
 * override -- storing it would freeze today's feed text over tomorrow's.
 * Returns null when nothing differs from the baked page (delete the row).
 */
function overrideFor(book, body) {
  const f = cleanFields(body);
  const feedDesc = String(book && book.description || '').replace(/\r\n?/g, '\n').trim();
  if (f.description && f.description === feedDesc) f.description = null;
  return FIELDS.some((k) => f[k]) ? f : null;
}

/** Publish the whole table to KV. Never throws; says what happened. */
async function publishContentIndex(supabase) {
  try {
    const { data, error } = await supabase.from(TABLE).select(['slug', ...FIELDS].join(','));
    if (error) return { ok: false, error: error.message };
    const items = {};
    for (const r of data || []) {
      const s = normSlug(r.slug);
      if (!s) continue;
      const e = {};
      for (const f of FIELDS) if (r[f]) e[f] = r[f];
      if (Object.keys(e).length) items[s] = e;
    }
    // Required here, not at the top: @netlify/blobs exists only as the Worker's
    // alias for its KV shim, so a top-level require breaks every Node test.
    const { getStore } = require('@netlify/blobs');
    await getStore(STORE).setJSON(KEY, { items, updated_at: new Date().toISOString() });
    return { ok: true, count: Object.keys(items).length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** What the admin editor shows for a catalogue book: the feed's copy and any override. */
function feedCopy(book, slug) {
  return {
    slug,
    google_item_id: catalogueFeedId(slug),
    title: book.title || '',
    author: book.author || '',
    description: String(book.description || ''),
    publisher: book.publisher || '',
    isbn: book.isbn || '',
  };
}

module.exports = {
  TABLE, STORE, KEY, FIELDS, LIMITS, MIGRATION,
  catalogueBook, cleanFields, overrideFor, publishContentIndex, feedCopy, normSlug,
};
