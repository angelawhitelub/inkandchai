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
const { parseShippingRestrictionTags, normalizeShippingRule } = require('./shipping-restrictions');

// Hardcoded slug overrides — MUST stay in sync with `make_slug` in generate_site.py.
// (Combo packs ship under hand-picked slugs that don't follow the auto-slug rule.)
const SLUG_OVERRIDES = {
  'CUSTOM-KINGS-OF-SIN-COMPLETE-SET-6-AH':         'kings-of-sin-series-complete-set-6-books-ana-huang',
  'CUSTOM-HINDI-BESTSELLERS-COMBO-5':              '5-hindi-bestsellers-combo-set-of-5-books-MBO-5',
  'CUSTOM-100M-HINDI-COMBO-2':                     '100m-leads-hindi-100m-offers-hindi-combo-2-books',
  'CUSTOM-GOGGINS-COMBO-HI':                       'david-goggins-combo-hindi-cant-hurt-me-never-finished',
  'CUSTOM-MOTHER-MARY-COMES-TO-ME-HI-ARUNDHATI-ROY':'mother-mary-comes-to-me-hindi-edition-arundhati-roy',
  'CUSTOM-SHAKTI-GOGGINS-COMBO-3-HI':              'shakti-ke-48-niyam-cant-hurt-me-never-finished-hindi-combo-3-books',
  'CUSTOM-HIDDEN-HINDU-TRILOGY-3':                 'hidden-hindu-complete-trilogy-3-books-akshat-gupta',
  'CUSTOM-COLLEEN-HOOVER-STARTER-3':               'colleen-hoover-3-book-starter-set-it-ends-verity-reminders',
  'CUSTOM-ANA-HUANG-TWISTED-SPECIAL-3':            'ana-huang-twisted-special-editions-3-pack',
  'CUSTOM-ROBERT-GREENE-POWER-TRILOGY-3':          'robert-greene-power-trilogy-48-laws-human-nature-seduction',
  'CUSTOM-MARK-DOUGLAS-TRADING-DUO-2':             'mark-douglas-trading-duo-zone-disciplined-trader',
  'CUSTOM-HINDI-MOTIVATION-BIG-4':                 'hindi-motivation-big-4-atomic-habits-rich-dad-shakti-think',
  'CUSTOM-FELUDA-4-PACK':                          'feluda-complete-mysteries-4-book-set-satyajit-ray',
  'CUSTOM-STOIC-ESSENTIALS-TRIO-3':                'stoic-essentials-trio-ego-daily-stoic-meditations',
  'CUSTOM-ENID-BLYTON-FAMOUS-FIVE-1-3':            'enid-blyton-famous-five-books-1-2-3-starter-set',
  'CUSTOM-WEALTH-PACK-299':                        'wealth-starter-pack-psychology-of-money-rich-dad-think-grow',
  'CUSTOM-KIDS-ACTIVITY-4-PACK':                   'kids-activity-4-pack-pete-cat-wipe-clean-learning',
  'CUSTOM-CLASSIC-POCKET-TRIO-3':                  'classic-pocket-trio-diary-young-girl-alice-meditations',
  'CUSTOM-OSHO-DUO-2':                             'osho-duo-dhyan-darshan-nari-aur-kranti',
  'CUSTOM-ANA-HUANG-KINGS-SIN-1-3':                'ana-huang-kings-of-sin-series-books-1-2-3',
  'CUSTOM-OFF-CAMPUS-5-ELLE-KENNEDY':              'off-campus-complete-5-book-collection-elle-kennedy',
  'CUSTOM-PSYCH-MONEY-THINKING-FAST-HINDI-2':      'psychology-of-money-hindi-thinking-fast-slow-hindi-combo-2-books',
  'CUSTOM-OFF-CAMPUS-COMBO-3-EK':                  'the-deal-the-mistake-the-score-elle-kennedy-off-campus-combo',
  'CUSTOM-TAIWAN-TRAVELOGUE':                      'taiwan-travelogue-yang-shuang-zi-international-booker-prize',
};

// Mirrors `make_slug` in generate_site.py — slug from title (alphanumeric -> '-',
// trimmed to 55 chars) plus last 5 chars of shopify_id (lowercased).
function makeSlug(title, shopifyId) {
  const sid = String(shopifyId || '');
  if (SLUG_OVERRIDES[sid]) return SLUG_OVERRIDES[sid];
  const base = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 55);
  const suffix = sid.slice(-5).toLowerCase();
  return suffix ? `${base}-${suffix}` : base;
}

let _catalogIndex = null;
let _catalogLoadError = null;
function getCatalogIndex() {
  if (_catalogIndex) return _catalogIndex;
  // Netlify's function bundler can flatten directory structure, so the
  // relative path that works in development doesn't always work in
  // production. Try the known candidates in order and use the first one
  // that loads. get-book.js uses `../../data/ALL_BOOKS.json` from
  // netlify/functions/ — replicate that, plus a few fallbacks.
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'data', 'ALL_BOOKS.json'), // dev: from utils/
    path.join(__dirname, '..', '..', 'data', 'ALL_BOOKS.json'),       // bundled flat
    path.join(process.cwd(), 'data', 'ALL_BOOKS.json'),               // function cwd
    path.join('/var/task', 'data', 'ALL_BOOKS.json'),                 // AWS Lambda layout
    'data/ALL_BOOKS.json',                                            // last resort
  ];
  let raw = null;
  const tried = [];
  for (const p of candidates) {
    try {
      raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      console.log('[pricing] catalogue loaded from', p);
      break;
    } catch (e) {
      tried.push(`${p}: ${e.code || e.message}`);
    }
  }
  if (!raw) {
    _catalogLoadError = `ALL_BOOKS.json not found. Tried:\n  ${tried.join('\n  ')}`;
    console.error('[pricing]', _catalogLoadError);
    return null;
  }
  _catalogIndex = {};
  for (const b of raw) {
    const price = Number.parseFloat(b.price_inr || 0) || 0;
    if (price <= 0) continue;
    const title = String(b.title || '').slice(0, 240);
    const entry = {
      slug: '', title, price,
      shippingRestrictions: parseShippingRestrictionTags(b.tags),
    };
    // Index under BOTH the computed make_slug (matches /product/ pages generated
    // by generate_site.py) AND the slug embedded in the raw `url` field if it
    // points at our domain (matches manually-curated CUSTOM listings).
    const computed = makeSlug(b.title || '', b.shopify_id || '').toLowerCase();
    if (computed) {
      _catalogIndex[computed] = { ...entry, slug: computed };
    }
    const urlSlug = slugFromUrl(b.url || '');
    if (urlSlug && urlSlug !== computed && !_catalogIndex[urlSlug]) {
      _catalogIndex[urlSlug] = { ...entry, slug: urlSlug };
    }
  }
  console.log(`[pricing] indexed ${Object.keys(_catalogIndex).length} books`);
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

  const index = getCatalogIndex() || {};

  // Normalise every cart line to {slug, qty, raw} up front.
  const items = [];
  const dropped = [];
  for (const raw of cart) {
    const slug = extractSlug(raw);
    const qty = Math.max(1, Math.floor(Number(raw?.qty) || 1));
    if (!slug) { dropped.push({ reason: 'no_slug', item: raw }); continue; }
    items.push({ slug, qty, raw });
  }

  // The custom_products table is the LIVE, admin-editable source of truth (it's
  // what get-product-overrides serves to the storefront). The static catalogue
  // `index` is baked at build time, so a price the admin changed after the last
  // deploy is stale there. Previously we only consulted custom_products for
  // slugs MISSING from the index — which meant an admin-edited price on a
  // product that WAS in the baked index (e.g. a ₹999→₹799 combo) showed ₹799 on
  // the page but charged the stale ₹999. So: query custom_products for ALL cart
  // slugs and let a live override win over the baked price.
  // Match case-INSENSITIVELY: cart slugs come from the (lower-cased) product
  // URL, but stored slugs often carry an upper-case suffix code (e.g.
  // "...-books-MBO-5"), so a case-sensitive `.in()` silently misses them. `ilike`
  // with no % wildcards is an equality match that ignores case. Slugs are
  // [a-z0-9-] only, so they carry no PostgREST OR-filter metacharacters.
  const slugs = [...new Set(items.map(c => c.slug))];
  const orFilter = slugs.map(s => `slug.ilike.${s}`).join(',');
  const ts = (v) => { const t = v ? Date.parse(v) : 0; return Number.isFinite(t) ? t : 0; };

  const customMap = {};
  if (items.length && supabase) {
    const { data, error } = await supabase
      .from('custom_products')
      .select('slug,title,price_inr,is_active,tags,updated_at')
      .or(orFilter);
    if (error) console.error('[pricing] custom_products lookup:', error.message);
    for (const row of (data || [])) {
      if (row.is_active === false) continue;
      const price = Number.parseFloat(row.price_inr || 0) || 0;
      if (price <= 0) continue;
      const publisherSourced = /publisher-sourced-bestseller/i.test(String(row.tags || ''));
      const noCod = /(?:^|,)\s*no-cod\s*(?:,|$)/i.test(String(row.tags || ''));
      customMap[String(row.slug).toLowerCase()] = {
        title: row.title || '', price, publisherSourced, noCod,
        shippingRestrictions: parseShippingRestrictionTags(row.tags),
        updatedAt: ts(row.updated_at),
      };
    }
  }

  // product_overrides is the table the admin "Products & Prices" price editor
  // writes to (update-product-override.js), for ANY slug — catalogue or custom.
  // The product PAGE applies it, but resolveCartPrices previously did NOT, so an
  // admin price change showed on the page (e.g. ₹299) while the ORDER still
  // charged the stale baked price (₹349 → ₹409 COD). Consult it here too.
  const overrideMap = {};
  if (items.length && supabase) {
    const { data, error } = await supabase
      .from('product_overrides')
      .select('slug,title,price_inr,is_active,updated_at')
      .or(orFilter);
    if (error) console.error('[pricing] product_overrides lookup:', error.message);
    for (const row of (data || [])) {
      if (row.is_active === false) continue;
      const price = Number.parseFloat(row.price_inr || 0) || 0;
      if (price <= 0) continue;
      overrideMap[String(row.slug).toLowerCase()] = { title: row.title || '', price, updatedAt: ts(row.updated_at) };
    }
  }

  // Delivery rules live in their own table so ordinary product metadata saves
  // cannot silently erase them. Product-tag rules remain only as a backwards-
  // compatible fallback for listings that have not yet been migrated.
  const shippingRuleMap = {};
  if (items.length && supabase) {
    const { data, error } = await supabase
      .from('product_shipping_rules')
      .select('slug,excluded_states,excluded_pincodes')
      .or(orFilter);
    if (error) console.error('[pricing] product_shipping_rules lookup:', error.message);
    for (const row of (data || [])) {
      shippingRuleMap[String(row.slug).toLowerCase()] = normalizeShippingRule(row);
    }
  }

  const resolved = [];
  for (const { slug, qty, raw } of items) {
    const override = overrideMap[slug];      // admin price edit (product_overrides)
    const custom = customMap[slug];          // custom_products live listing
    const staticHit = index[slug];           // baked catalogue price (fallback)
    // Any LIVE source beats the baked static price. When both live sources exist
    // for a slug, the most recently edited one wins — correct whether the price
    // was changed via the override editor or the custom-product editor.
    let live = null;
    if (override && custom) live = override.updatedAt >= custom.updatedAt ? override : custom;
    else live = override || custom;
    if (live) {
      const item = { ...raw, slug, qty, title: live.title || custom?.title || staticHit?.title || raw?.title, price: live.price };
      // COD / publisher-sourced flags only live on custom_products rows.
      if (custom?.publisherSourced) item._publisher_sourced = true;
      if (custom?.noCod) item._no_cod = true;
      const shippingRestrictions = shippingRuleMap[slug] || custom?.shippingRestrictions || staticHit?.shippingRestrictions;
      if (shippingRestrictions?.states?.length || shippingRestrictions?.pins?.length) {
        item._shipping_restrictions = shippingRestrictions;
      }
      resolved.push(item);
    } else if (staticHit) {
      const item = { ...raw, slug, qty, title: staticHit.title, price: staticHit.price };
      const shippingRestrictions = shippingRuleMap[slug] || staticHit.shippingRestrictions;
      if (shippingRestrictions?.states?.length || shippingRestrictions?.pins?.length) {
        item._shipping_restrictions = shippingRestrictions;
      }
      resolved.push(item);
    } else {
      dropped.push({ reason: 'not_in_catalogue', slug, item: raw });
    }
  }

  const subtotal = resolved.reduce((s, i) => s + i.price * i.qty, 0);
  return { cart: resolved, subtotal, dropped };
}

/**
 * Sync check on an already-resolved cart (from resolveCartPrices).
 * Crossword-migrated genuine-tag products carry `_publisher_sourced: true`
 * after price resolution — orders containing any such item get a distinct
 * "IC-CW-" prefix so they're trivially filterable in the admin panel.
 */
function cartHasPublisherSourced(cart) {
  if (!Array.isArray(cart)) return false;
  return cart.some(i => i && i._publisher_sourced === true);
}

// True when the (server-resolved) cart holds any COD-disabled item — the full
// crossword.in catalogue import. Used by cod-order.js to hard-reject a COD
// attempt even if the client UI was bypassed.
function cartHasNoCod(cart) {
  if (!Array.isArray(cart)) return false;
  return cart.some(i => i && i._no_cod === true);
}

/**
 * Generate an order ID. Pass `prefixBase` for the variant ('IC' for normal,
 * 'IC-R' for replacements). Crossword-sourced carts get '-CW' appended after
 * the base. If the cart hasn't been priced yet (no _publisher_sourced flag)
 * and `supabase` is provided, we do a fast slug lookup to decide.
 */
async function makeOrderId(prefixBase, cart, supabase) {
  let hasCW = cartHasPublisherSourced(cart);
  if (!hasCW && supabase && Array.isArray(cart) && cart.length) {
    const slugs = cart.map(extractSlug).filter(Boolean);
    if (slugs.length) {
      try {
        const { data } = await supabase
          .from('custom_products')
          .select('slug,tags')
          .in('slug', slugs);
        hasCW = (data || []).some(r => /publisher-sourced-bestseller/i.test(String(r.tags || '')));
      } catch (e) { /* non-fatal — fall back to standard prefix */ }
    }
  }
  const datePart = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const randPart = Math.random().toString(36).slice(2,7).toUpperCase();
  const prefix   = hasCW ? `${prefixBase}-CW` : prefixBase;
  return `${prefix}-${datePart}-${randPart}`;
}

module.exports = { resolveCartPrices, getCatalogIndex, cartHasPublisherSourced, cartHasNoCod, makeOrderId, makeSlug };
