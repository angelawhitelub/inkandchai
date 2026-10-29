/**
 * Scheduled function: lifetime-sales-scheduled   (hourly, jobs.toml)
 *
 * Counts lifetime units sold per book over every placed, not-cancelled order
 * and publishes them to KV (utils/lifetime-sales). Read-only on orders; writes
 * nothing but the published counts. Admin may run it by POST to refresh now.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const {
  newTally, addOrders, finishTally, publishLifetimeSales, titleKey, cleanSalesSlug, carriedCounts, SOLD_STATUSES,
} = require('./utils/lifetime-sales');
const catalogIndex = require('../../data/catalog-index.json');
const { catalogueBook } = require('./utils/catalog-content');
const { readDeleted } = require('./utils/deleted-products');
const { proxifySupabaseImage } = require('./utils/supabase-img');
const bsr = require('./utils/bestseller-rank');

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/**
 * From the catalogue and admin books: title → slug for cart lines saved
 * without a slug, and copy → original for duplicated listings
 * (custom_products.sales_from_slug, sql/custom_products_sales_from_slug.sql).
 */
async function catalogueMaps(db) {
  const map = new Map();
  const lineage = new Map();
  for (const b of Object.values(catalogIndex || {})) {
    if (b && b.title && b.slug) map.set(titleKey(b.title), String(b.slug).toLowerCase());
  }
  // Before the migration the column does not exist; count as before.
  // author/category/image_url feed the Best Sellers Rank shelves and cards.
  const meta = new Map();
  let cols = 'slug,title,author,category,image_url,sales_from_slug';
  for (let from = 0; from < 50000; from += 1000) {
    let { data, error } = await db.from('custom_products').select(cols).order('slug').range(from, from + 999);
    if (error && cols.includes('sales_from_slug') && /sales_from_slug/i.test(error.message || '')) {
      cols = 'slug,title,author,category,image_url';
      ({ data, error } = await db.from('custom_products').select(cols).order('slug').range(from, from + 999));
    }
    if (error) throw new Error(`custom_products: ${error.message}`);
    for (const p of data || []) {
      if (p.title && p.slug && !map.has(titleKey(p.title))) map.set(titleKey(p.title), String(p.slug).toLowerCase());
      if (p.slug) meta.set(String(p.slug).toLowerCase(), { title: p.title, author: p.author, category: p.category, img: proxifySupabaseImage(String(p.image_url || '')) });
      const copy = cleanSalesSlug(p.slug);
      const original = cleanSalesSlug(p.sales_from_slug);
      if (copy && original && copy !== original) lineage.set(copy, original);
    }
    if (!data || data.length < 1000) break;
  }
  return { slugByTitle: map, lineage, meta };
}

/** Admin edits to a book's category, title or cover (product_overrides). Empty on any error. */
async function overrideMeta(db) {
  const out = new Map();
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await db.from('product_overrides').select('slug,title,author,category,image_url').order('slug').range(from, from + 999);
    if (error) { console.warn('[lifetime-sales] product_overrides:', error.message); return out; }
    for (const o of data || []) if (o.slug) out.set(String(o.slug).toLowerCase(), o);
    if (!data || data.length < 1000) break;
  }
  return out;
}

/**
 * Best Sellers Rank (utils/bestseller-rank) from the lifetime and last-30-day
 * counts. A copy carries its original's sales here too, as on the page.
 */
async function buildRanks(db, { doc, recentDoc, lineage, meta, info }) {
  const add = (counts, carried) => {
    const out = { ...counts };
    for (const [s, n] of Object.entries(carried || {})) out[s] = (Number(out[s]) || 0) + n;
    return out;
  };
  const lifetime = add(doc.counts, doc.carried);
  const recent = add(recentDoc.counts, carriedCounts(recentDoc.counts, lineage));
  const deleted = await readDeleted(db);
  const overrides = await overrideMeta(db);
  const about = (slug) => {
    const o = overrides.get(slug) || {};
    const c = meta.get(slug) || {};
    const book = c.title ? null : catalogueBook(slug);
    const cart = info.get(slug) || {};
    const pick = (...v) => v.map((x) => String(x || '').trim()).find(Boolean) || '';
    return {
      title: pick(o.title, c.title, book && book.title, cart.title),
      author: pick(o.author, c.author, book && book.author, cart.author),
      category: pick(o.category, c.category, book && book.category),
      img: pick(o.image_url && proxifySupabaseImage(o.image_url), c.img, book && bsr.catalogueCover(book.image_url), cart.img),
    };
  };
  const ranked = bsr.computeRanks({
    lifetime, recent, exclude: new Set(deleted.slugs || []),
    shelfFor: (slug) => bsr.shelfOf(about(slug).category),
  });
  const cards = {};
  for (const slug of bsr.listedSlugs(ranked)) {
    const a = about(slug);
    if (a.title) cards[slug] = { title: a.title, author: a.author, img: a.img };
  }
  return {
    ranks: ranked.ranks,
    order: ranked.order.filter((s) => cards[s]),   // the books /bestsellers/ can list, in rank order
    shelves: ranked.shelves, info: cards, window_days: bsr.WINDOW_DAYS,
  };
}

exports.handler = async (event = {}) => {
  // The scheduler's event has no rawUrl; anything over HTTP must be an admin.
  if (event.rawUrl) {
    const blocked = requireAdmin(event, { 'Content-Type': 'application/json' });
    if (blocked) return blocked;
  }
  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { slugByTitle, lineage, meta } = await catalogueMaps(db);
    const tally = newTally();
    const recentTally = newTally();
    const since = Date.now() - bsr.WINDOW_DAYS * 86400000;
    let read = 0;
    for (let from = 0; from < 500000; from += 1000) {
      const { data, error } = await db.from('orders')
        .select('razorpay_order_id,source,cart_items,created_at')
        .in('status', SOLD_STATUSES)
        .order('created_at', { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(`orders: ${error.message}`);
      addOrders(tally, data || [], { slugByTitle });
      addOrders(recentTally, (data || []).filter((o) => Date.parse(o.created_at) >= since), { slugByTitle });
      read += (data || []).length;
      if (!data || data.length < 1000) break;
    }
    const doc = finishTally(tally);
    // Kept apart from `counts` so the Reader Bestsellers ranking still counts
    // each listing's own sales once; product pages and cards add them.
    doc.carried = carriedCounts(doc.counts, lineage);
    // A failure here must not cost the page its sold counts: publish without ranks.
    try {
      doc.bsr = await buildRanks(db, { doc, recentDoc: finishTally(recentTally), lineage, meta, info: tally.info });
    } catch (e) {
      console.error('[lifetime-sales] best sellers rank:', e.message);
    }
    await publishLifetimeSales(doc);
    const books = Object.keys(doc.counts).length;
    console.log(`[lifetime-sales] ${read} orders read, ${doc.orders} counted, ${books} books, ${Object.keys(doc.carried).length} copies carry counts, top ${doc.top[0] ? `${doc.top[0].slug}=${doc.top[0].qty}` : '-'}`);
    return json(200, {
      ok: true, orders_read: read, orders_counted: doc.orders, books, carried: doc.carried, top: doc.top.slice(0, 5).map((t) => [t.slug, t.qty]),
      ranked: doc.bsr ? Object.keys(doc.bsr.ranks).length : 0, bsr_top: doc.bsr ? doc.bsr.order.slice(0, 5) : [],
    });
  } catch (e) {
    console.error('[lifetime-sales]', e.message);
    return json(500, { error: e.message });
  }
};
