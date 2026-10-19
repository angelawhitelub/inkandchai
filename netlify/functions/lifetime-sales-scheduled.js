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
  let cols = 'slug,title,sales_from_slug';
  for (let from = 0; from < 50000; from += 1000) {
    let { data, error } = await db.from('custom_products').select(cols).order('slug').range(from, from + 999);
    if (error && cols.includes('sales_from_slug') && /sales_from_slug/i.test(error.message || '')) {
      cols = 'slug,title';
      ({ data, error } = await db.from('custom_products').select(cols).order('slug').range(from, from + 999));
    }
    if (error) throw new Error(`custom_products: ${error.message}`);
    for (const p of data || []) {
      if (p.title && p.slug && !map.has(titleKey(p.title))) map.set(titleKey(p.title), String(p.slug).toLowerCase());
      const copy = cleanSalesSlug(p.slug);
      const original = cleanSalesSlug(p.sales_from_slug);
      if (copy && original && copy !== original) lineage.set(copy, original);
    }
    if (!data || data.length < 1000) break;
  }
  return { slugByTitle: map, lineage };
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
    const { slugByTitle, lineage } = await catalogueMaps(db);
    const tally = newTally();
    let read = 0;
    for (let from = 0; from < 500000; from += 1000) {
      const { data, error } = await db.from('orders')
        .select('razorpay_order_id,source,cart_items')
        .in('status', SOLD_STATUSES)
        .order('created_at', { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(`orders: ${error.message}`);
      addOrders(tally, data || [], { slugByTitle });
      read += (data || []).length;
      if (!data || data.length < 1000) break;
    }
    const doc = finishTally(tally);
    // Kept apart from `counts` so the Reader Bestsellers ranking still counts
    // each listing's own sales once; product pages and cards add them.
    doc.carried = carriedCounts(doc.counts, lineage);
    await publishLifetimeSales(doc);
    const books = Object.keys(doc.counts).length;
    console.log(`[lifetime-sales] ${read} orders read, ${doc.orders} counted, ${books} books, ${Object.keys(doc.carried).length} copies carry counts, top ${doc.top[0] ? `${doc.top[0].slug}=${doc.top[0].qty}` : '-'}`);
    return json(200, { ok: true, orders_read: read, orders_counted: doc.orders, books, carried: doc.carried, top: doc.top.slice(0, 5).map((t) => [t.slug, t.qty]) });
  } catch (e) {
    console.error('[lifetime-sales]', e.message);
    return json(500, { error: e.message });
  }
};
