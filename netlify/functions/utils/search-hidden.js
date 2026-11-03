/**
 * Books hidden from the site search (owner, 25 Oct 2026).
 *
 * A hidden book is still for sale: its product page, collections, category
 * pages, cart and checkout are untouched. It just never comes back from the
 * search bar -- the homepage search (window.__searchHiddenSlugs, from
 * get-product-overrides), the suggestion dropdown (search-suggest) and the
 * full results (catalog-search).
 *
 * The list is small and hand-curated, so it lives in one blob (KV key
 * `catalog:search-hidden` on the Worker) and every change rewrites it whole,
 * like the deleted-products index. No SQL migration needed.
 */
const { getStore } = require('@netlify/blobs');

const STORE = 'catalog';
const KEY = 'search-hidden';
const MAX = 2000;

const normSlug = (s) => String(s || '').trim().toLowerCase()
  .replace(/[?#].*$/, '').replace(/^https?:\/\/[^/]+/, '').replace(/^\/?product\//, '')
  .replace(/^\/+|\/+$/g, '').slice(0, 200);

/** Every hidden book, newest first: [{ slug, title, hidden_at }]. */
async function readHidden() {
  const doc = await getStore(STORE).get(KEY, { type: 'json' });
  const items = doc && Array.isArray(doc.items) ? doc.items : [];
  return items.filter((i) => i && normSlug(i.slug)).map((i) => ({ ...i, slug: normSlug(i.slug) }));
}

/** Turns hiding on or off for one slug; returns the new list. */
async function setHidden(slug, hidden, { title = '' } = {}) {
  const s = normSlug(slug);
  if (!s) throw new Error('Missing product slug');
  const items = (await readHidden()).filter((i) => i.slug !== s);
  if (hidden) items.unshift({ slug: s, title: String(title || '').slice(0, 200), hidden_at: new Date().toISOString() });
  if (items.length > MAX) throw new Error(`At most ${MAX} books can be hidden from search.`);
  await getStore(STORE).setJSON(KEY, { items, updated_at: new Date().toISOString() });
  _set = new Set(items.map((i) => i.slug));
  _at = Date.now();
  return items;
}

// Read paths: cached per isolate for a minute, failing open to the last good
// set -- a storage hiccup must not empty or break search.
const TTL_MS = 60_000;
let _set = null;
let _at = 0;
async function hiddenSlugSet() {
  if (_set && Date.now() - _at < TTL_MS) return _set;
  try {
    _set = new Set((await readHidden()).map((i) => i.slug));
    _at = Date.now();
  } catch (err) {
    console.warn('[search-hidden] read failed:', err.message);
  }
  return _set || new Set();
}

/** Deleted + hidden: the slugs search must never return. */
async function unsearchableSlugSet(deletedSet) {
  const hidden = await hiddenSlugSet();
  if (!hidden.size) return deletedSet;
  return new Set([...deletedSet, ...hidden]);
}

module.exports = { readHidden, setHidden, hiddenSlugSet, unsearchableSlugSet, normSlug, STORE, KEY };
