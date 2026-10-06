/**
 * Which products are sold out: an active product_overrides row whose manual
 * stock (stock_qty) is 0 or less -- what the admin's stock field and
 * "Remove From Sale" set, and what the product page turns into "Coming Soon".
 *
 * Used where the browser's own check comes too late: Google's feeds and the
 * product page's structured data (via the sold-out-slugs function, read by the
 * Worker), and the custom-product feeds. Checkout reads the same rule per
 * cart in utils/pricing.js.
 */

/** Set of lower-cased slugs. Throws on a database error; callers decide how to fail. */
async function soldOutSlugs(db) {
  const { data, error } = await db.from('product_overrides')
    .select('slug,stock_qty,is_active')
    .lte('stock_qty', 0);
  if (error) throw new Error(error.message);
  return new Set((data || [])
    .filter((r) => r.is_active !== false && r.stock_qty !== null && Number(r.stock_qty) <= 0)
    .map((r) => String(r.slug || '').toLowerCase())
    .filter(Boolean));
}

/**
 * feed.xml with every sold-out item's <g:availability> set to "out of stock".
 * Items are matched on <g:id>, which for catalogue books is the slug.
 */
function markFeedSoldOut(xml, sold) {
  if (!sold || !sold.size) return { xml, changed: 0 };
  let changed = 0;
  const out = String(xml).replace(/<item>[\s\S]*?<\/item>/g, (item) => {
    const id = (item.match(/<g:id>([^<]*)<\/g:id>/) || [])[1];
    if (!id || !sold.has(id.trim().toLowerCase())) return item;
    const next = item.replace(/<g:availability>[^<]*<\/g:availability>/, '<g:availability>out of stock</g:availability>');
    if (next !== item) changed++;
    return next;
  });
  return { xml: out, changed };
}

/** A product page's JSON-LD with InStock turned into OutOfStock. */
const markJsonLdSoldOut = (json) => String(json).replace(/https?:\/\/schema\.org\/InStock/g, 'https://schema.org/OutOfStock');

module.exports = { soldOutSlugs, markFeedSoldOut, markJsonLdSoldOut };
