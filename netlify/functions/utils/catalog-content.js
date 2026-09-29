/**
 * Admin-written copy AND book details (publisher, ISBN, pages…) for CATALOGUE
 * books -- the baked pages from data/ALL_BOOKS.json, which have no
 * custom_products row to hold them.
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
const COPY_LIMITS = { description: 5000, author_bio: 3000, seo_title: 150, meta_description: 320, tags: 600 };
// Book details -- the same boxes (and caps) a custom listing has. Blank means
// "as the baked page has it": publisher/ISBN keep the feed's value, the rest
// simply do not get a row.
const FACT_LIMITS = {
  publisher: 160, isbn: 80, format: 60, language: 60, pages: 20000,
  dimensions: 80, weight_grams: 50000, edition: 80, published_on: 40, reading_age: 40,
};
const NUMERIC = new Set(['pages', 'weight_grams']);
const LIMITS = { ...COPY_LIMITS, ...FACT_LIMITS };
const FIELDS = Object.keys(LIMITS);
const FACT_FIELDS = Object.keys(FACT_LIMITS);
const MIGRATION = 'sql/catalog_content.sql';

const normSlug = (s) => String(s || '').trim().toLowerCase();
const oneLine = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

// Supplier and placeholder names the baked page never shows (it prints
// "Ink & Chai" instead). Mirrors _HIDDEN_PUBLISHERS in generate_site.py.
const HIDDEN_PUBLISHERS = new Set([
  'prakash books', 'new kids', '99bookstore', '99bookstores', '99 bookstore',
  'ink and chai', 'ink & chai', 'inkandchai', 'various', 'anonymous', 'unknown',
  'various authors', 'multiple authors', 'n/a', '—', '-',
]);
/** The publisher the baked page shows for this book ('' = the store name). */
function pagePublisher(book) {
  const p = oneLine(book && book.publisher);
  return HIDDEN_PUBLISHERS.has(p.toLowerCase()) ? '' : p;
}

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
    if (NUMERIC.has(f)) {
      const n = Math.round(Number(oneLine(body[f])));
      out[f] = Number.isFinite(n) && n > 0 && n <= LIMITS[f] ? n : null;
      continue;
    }
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
  // Same for the two details the baked page already prints: re-saving what the
  // editor was pre-filled with is not an override.
  if (f.publisher && f.publisher === pagePublisher(book)) f.publisher = null;
  if (f.isbn && f.isbn === oneLine(book && book.isbn)) f.isbn = null;
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
      for (const f of FIELDS) if (r[f] != null && r[f] !== '') e[f] = r[f];
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
    // What the page shows, not the raw feed: a supplier name here would be
    // saved straight back onto the page by the next edit.
    publisher: pagePublisher(book),
    isbn: oneLine(book.isbn),
  };
}

module.exports = {
  TABLE, STORE, KEY, FIELDS, FACT_FIELDS, LIMITS, MIGRATION,
  catalogueBook, cleanFields, overrideFor, publishContentIndex, feedCopy, normSlug, pagePublisher,
};
