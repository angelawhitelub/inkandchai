/**
 * Server-side authoritative pricing.
 *
 * NEVER trust client-supplied `price` on cart items — the browser is hostile.
 * Resolve every cart line's price from the canonical catalogue (data/ALL_BOOKS.json
 * for the static catalogue, custom_products table for admin-injected listings).
 *
 * Returns a sanitized cart with server prices + a server-computed subtotal in rupees.
 * Items that resolve to no price are dropped and surfaced in `dropped[]`.
 */

const path = require('path');
const fs   = require('fs');

let _catalogIndex = null;
function getCatalogIndex() {
  if (_catalogIndex) return _catalogIndex;
  const filePath = path.join(__dirname, '..', '..', '..', 'data', 'ALL_BOOKS.json');
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  _catalogIndex = {};
  for (const b of raw) {
    const slug = slugFromUrl(b.url || '');
    if (!slug) continue;
    const price = Number.parseFloat(b.price_inr || 0) || 0;
    if (price <= 0) continue;
    _catalogIndex[slug.toLowerCase()] = {
      slug,
      title: String(b.title || '').slice(0, 240),
      price,
    };
  }
  return _catalogIndex;
}

function slugFromUrl(url) {
  const m = String(url || '').match(/\/product\/([^/?#]+)/);
  return m ? m[1].toLowerCase() : '';
}

function extractSlug(item) {
  if (!item) return '';
  // checkout passes { url, id, slug, ... } — id/url are usually "/product/<slug>/"
  return (
    slugFromUrl(item.url) ||
    slugFromUrl(item.id) ||
    String(item.slug || '').toLowerCase()
  );
}

/**
 * @param {Array} cart  - client-supplied cart items
 * @param {object} supabase - Supabase client (service key) — used for custom_products lookup
 * @returns {Promise<{ cart: Array, subtotal: number, dropped: Array }>}
 */
async function resolveCartPrices(cart, supabase) {
  if (!Array.isArray(cart) || cart.length === 0) {
    return { cart: [], subtotal: 0, dropped: [] };
  }

  const index = getCatalogIndex();

  // First pass: catalogue lookups (synchronous)
  const resolved = [];
  const dropped = [];
  const customLookups = []; // slugs to query in custom_products

  for (const raw of cart) {
    const slug = extractSlug(raw);
    const qty = Math.max(1, Math.floor(Number(raw?.qty) || 1));
    if (!slug) { dropped.push({ reason: 'no_slug', item: raw }); continue; }
    const hit = index[slug];
    if (hit) {
      resolved.push({ ...raw, slug, qty, title: hit.title, price: hit.price });
    } else {
      customLookups.push({ slug, qty, raw });
    }
  }

  // Second pass: custom_products in one batched query
  if (customLookups.length && supabase) {
    const slugs = [...new Set(customLookups.map(c => c.slug))];
    const { data, error } = await supabase
      .from('custom_products')
      .select('slug,title,price_inr,is_active')
      .in('slug', slugs);
    if (error) console.error('[pricing] custom_products lookup:', error.message);
    const customMap = {};
    for (const row of (data || [])) {
      if (row.is_active === false) continue;
      const price = Number.parseFloat(row.price_inr || 0) || 0;
      if (price <= 0) continue;
      customMap[String(row.slug).toLowerCase()] = { title: row.title || '', price };
    }
    for (const { slug, qty, raw } of customLookups) {
      const hit = customMap[slug];
      if (hit) {
        resolved.push({ ...raw, slug, qty, title: hit.title, price: hit.price });
      } else {
        dropped.push({ reason: 'not_in_catalogue', slug, item: raw });
      }
    }
  } else if (customLookups.length) {
    for (const { raw, slug } of customLookups) {
      dropped.push({ reason: 'not_in_catalogue', slug, item: raw });
    }
  }

  const subtotal = resolved.reduce((s, i) => s + i.price * i.qty, 0);
  return { cart: resolved, subtotal, dropped };
}

module.exports = { resolveCartPrices, getCatalogIndex };
