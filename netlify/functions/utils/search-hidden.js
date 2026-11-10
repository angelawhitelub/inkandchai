/**
 * Books the owner has hidden, as two separate lists. A hidden book stays for
 * sale and its product page, cart and checkout are untouched either way.
 *
 * Search (25 Oct 2026): it never comes back from the search bar -- the homepage
 * search (window.__searchHiddenSlugs, from get-product-overrides), the
 * suggestion dropdown (search-suggest) and the full results (catalog-search).
 *
 * Browsing (4 Nov 2026): it is left off every page that lists books. The Worker
 * serves the list as /browse-hidden.json and cart.js, which loads on every
 * shopping page, hides its cards. It still comes up in search unless it is on
 * the search list too, so a book on both lists opens only from its URL.
 *
 * Sold count (10 Nov 2026): the book's "🔥 N sold" card line (sold-counts) and
 * its product page "bought in past month" line (Worker withSoldCount) are not
 * shown, nor its #1 Best Seller badge, Best Sellers Rank row or the #N on its
 * /bestsellers/ card (it stays listed there). Sales still count in the ranks
 * of other books and in reports.
 *
 * Each list is small and hand-curated, so it lives in one blob (KV keys
 * `catalog:search-hidden` and `catalog:browse-hidden` on the Worker) and every
 * change rewrites it whole, like the deleted-products index. No SQL migration.
 */
const { getStore } = require('@netlify/blobs');

const STORE = 'catalog';
const KEY = 'search-hidden';
const BROWSE_KEY = 'browse-hidden';
const SOLD_KEY = 'sold-count-hidden';
const MAX = 2000;

const normSlug = (s) => String(s || '').trim().toLowerCase()
  .replace(/[?#].*$/, '').replace(/^https?:\/\/[^/]+/, '').replace(/^\/?product\//, '')
  .replace(/^\/+|\/+$/g, '').slice(0, 200);

/**
 * One hand-curated list of slugs in one blob. `search` and `browse` below are
 * separate lists, so hiding a book from one never touches the other.
 */
function makeList(key, label) {
  /** Every hidden book, newest first: [{ slug, title, hidden_at }]. */
  async function readHidden() {
    const doc = await getStore(STORE).get(key, { type: 'json' });
    const items = doc && Array.isArray(doc.items) ? doc.items : [];
    return items.filter((i) => i && normSlug(i.slug)).map((i) => ({ ...i, slug: normSlug(i.slug) }));
  }

  // Read paths: cached per isolate for a minute, failing open to the last good
  // set -- a storage hiccup must not empty or break search or browsing.
  let set = null;
  let at = 0;

  /** Turns hiding on or off for one slug; returns the new list. */
  async function setHidden(slug, hidden, { title = '' } = {}) {
    const s = normSlug(slug);
    if (!s) throw new Error('Missing product slug');
    const items = (await readHidden()).filter((i) => i.slug !== s);
    if (hidden) items.unshift({ slug: s, title: String(title || '').slice(0, 200), hidden_at: new Date().toISOString() });
    if (items.length > MAX) throw new Error(`At most ${MAX} books can be hidden from ${label}.`);
    await getStore(STORE).setJSON(key, { items, updated_at: new Date().toISOString() });
    set = new Set(items.map((i) => i.slug));
    at = Date.now();
    return items;
  }

  /**
   * Hides or shows many books in one rewrite (admin inventory). `titles` maps
   * slug → title. Returns { items, changed: [slug] } -- only the slugs whose
   * state actually changed, so an undo touches nothing else.
   */
  async function setManyHidden(slugs, hidden, { titles = {} } = {}) {
    const want = [...new Set((slugs || []).map(normSlug).filter(Boolean))];
    let items = await readHidden();
    const had = new Set(items.map((i) => i.slug));
    const changed = want.filter((s) => had.has(s) !== !!hidden);
    if (!changed.length) return { items, changed };
    const drop = new Set(changed);
    if (hidden) {
      const stamp = new Date().toISOString();
      items = changed.map((s) => ({ slug: s, title: String(titles[s] || '').slice(0, 200), hidden_at: stamp })).concat(items);
    } else {
      items = items.filter((i) => !drop.has(i.slug));
    }
    if (items.length > MAX) throw new Error(`At most ${MAX} books can be hidden from ${label}.`);
    await getStore(STORE).setJSON(key, { items, updated_at: new Date().toISOString() });
    set = new Set(items.map((i) => i.slug));
    at = Date.now();
    return { items, changed };
  }

  async function hiddenSlugSet() {
    if (set && Date.now() - at < TTL_MS) return set;
    try {
      set = new Set((await readHidden()).map((i) => i.slug));
      at = Date.now();
    } catch (err) {
      console.warn(`[${key}] read failed:`, err.message);
    }
    return set || new Set();
  }

  return { readHidden, setHidden, setManyHidden, hiddenSlugSet };
}

const TTL_MS = 60_000;
const search = makeList(KEY, 'search');
const browse = makeList(BROWSE_KEY, 'browsing');
const sold = makeList(SOLD_KEY, 'sold counts');
const { readHidden, setHidden, hiddenSlugSet } = search;

/** Deleted + hidden: the slugs search must never return. */
async function unsearchableSlugSet(deletedSet) {
  const hidden = await hiddenSlugSet();
  if (!hidden.size) return deletedSet;
  return new Set([...deletedSet, ...hidden]);
}

module.exports = { readHidden, setHidden, hiddenSlugSet, unsearchableSlugSet, normSlug, browse, sold, STORE, KEY, BROWSE_KEY, SOLD_KEY };
