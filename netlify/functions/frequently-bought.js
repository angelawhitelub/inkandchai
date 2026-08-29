const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  // Fires on every product page. Recommendations are derived from the static
  // catalogue + rarely-changing custom_products, so cache at Netlify's edge
  // (durable) for 1h with a 24h SWR window — keeps Supabase out of the hot path.
  'Cache-Control': 'public, max-age=300',
  'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=3600, stale-while-revalidate=86400',
};

// ---------------------------------------------------------------------------
// Real purchase signals, built at deploy time by scripts/build-fbt-signals.js
// from a year of kept orders. `pairs` is how often two books went out in the
// same parcel; `bestsellers` is units actually sold. Read once per cold start.
//
// Everything below degrades cleanly when the file is missing or empty -- a
// deploy where Supabase was unreachable still serves similarity-only results.
// ---------------------------------------------------------------------------
let _signals = null;
function loadSignals() {
  if (_signals) return _signals;
  const candidates = [
    path.join(process.cwd(), 'data', 'fbt-signals.json'),
    path.join(__dirname, '..', '..', 'data', 'fbt-signals.json'),
    path.join('/var/task', 'data', 'fbt-signals.json'),
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const rank = new Map();
      (raw.bestsellers || []).forEach(([slug, sold], i) => rank.set(slug, { sold, rank: i }));
      _signals = { pairs: raw.pairs || {}, rank, generatedAt: raw.generated_at || null };
      return _signals;
    } catch (err) {
      console.warn('fbt-signals unreadable at', candidate, err.message);
    }
  }
  _signals = { pairs: {}, rank: new Map(), generatedAt: null };
  return _signals;
}

// How many times these two were actually bought together, across every alias
// either product answers to (a book can be reachable by more than one slug).
function coBuyCount(signals, base, candidate) {
  const baseKeys = [base.slug, ...(base.aliases || [])];
  const candKeys = new Set([candidate.slug, ...(candidate.aliases || [])]);
  let best = 0;
  for (const key of baseKeys) {
    for (const [partner, count] of signals.pairs[key] || []) {
      if (candKeys.has(partner) && count > best) best = count;
    }
  }
  return best;
}

// Units sold, best across aliases.
function unitsSold(signals, product) {
  let best = 0;
  for (const key of [product.slug, ...(product.aliases || [])]) {
    const hit = signals.rank.get(key);
    if (hit && hit.sold > best) best = hit.sold;
  }
  return best;
}

// The catalogue holds the same book under more than one slug (a re-import
// mints a new shopify_id, and combos get hand-picked slugs). Scoring treats
// those as separate products, so a strong recommendation would fill the whole
// panel with one title -- "The Art of Not Overthinking" four times over.
// Collapse on what a customer would call the same book: title + author.
function dedupeKey(product) {
  const norm = (v) => String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097f]+/g, ' ')
    .trim();
  return norm(product.title) + '|' + norm(product.author);
}

// Keep the first (highest-scoring) product for each distinct book.
function takeDistinct(rows, limit, pick = (row) => row) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = dedupeKey(pick(row));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

function findCataloguePath() {
  const candidates = [
    path.join(process.cwd(), 'data', 'ALL_BOOKS.json'),
    path.join(__dirname, '..', '..', 'data', 'ALL_BOOKS.json'),
    path.join('/var/task', 'data', 'ALL_BOOKS.json'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`Catalogue file not found. Checked: ${candidates.join(', ')}`);
  return found;
}

// Kept in sync with generate_site.py make_slug()

// Slug rule lives in utils/pricing.js — the ONLY copy. Local re-implementations
// here dropped the `.toLowerCase()` on the shopify_id suffix (and carried only a
// subset of the special-case slugs), so this file wrote/read product_overrides
// under e.g. "...-NG-HI" while the storefront looks for "...-ng-hi". 13 override
// rows — 12 of them price overrides — were silently doing nothing as a result.
const { makeSlug } = require('./utils/pricing');

function slugFromUrl(url) {
  try {
    const u = new URL(String(url || ''), 'https://inkandchai.in');
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'product' && parts[1]) return parts[1].toLowerCase();
    const id = u.searchParams.get('id');
    return id ? id.toLowerCase() : '';
  } catch {
    return '';
  }
}

function moneyText(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `₹ ${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '';
}

function priceNumber(value) {
  if (typeof value === 'number') return value;
  return Number(String(value || '').replace(/[^0-9.]/g, '')) || 0;
}

function tokenize(value) {
  const stop = new Set(['the', 'and', 'with', 'for', 'book', 'books', 'edition', 'paperback', 'by', 'of', 'a', 'an']);
  return new Set(String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097f]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stop.has(word)));
}

function deterministicHash(value) {
  return String(value || '').split('').reduce((acc, char) => ((acc * 31) + char.charCodeAt(0)) >>> 0, 7);
}

function normalizeRawBook(book) {
  const slug = makeSlug(book.title, book.shopify_id) || slugFromUrl(book.url);
  const urlSlug = slugFromUrl(book.url);
  const price = priceNumber(book.price_inr);
  return {
    slug,
    aliases: Array.from(new Set([slug, urlSlug].filter(Boolean).map((value) => value.toLowerCase()))),
    id: `/product/${slug}/`,
    url: `/product/${slug}/`,
    title: book.title || '',
    author: book.author || '',
    category: book.category || 'Books',
    tags: book.tags || '',
    description: book.description || '',
    price,
    priceText: moneyText(price),
    originalPrice: priceNumber(book.original_price_inr),
    originalPriceText: moneyText(book.original_price_inr),
    img: book.image_url || '',
  };
}

function normalizeCustomProduct(product) {
  const slug = String(product.slug || '').toLowerCase();
  const price = priceNumber(product.price_inr);
  return {
    slug,
    aliases: [slug],
    id: `/product/${slug}/`,
    url: `/product/${slug}/`,
    title: product.title || '',
    author: product.author || '',
    category: product.category || 'Books',
    tags: product.tags || '',
    description: product.description || '',
    price,
    priceText: moneyText(price),
    originalPrice: priceNumber(product.original_price_inr),
    originalPriceText: moneyText(product.original_price_inr),
    // Supabase-hosted covers → Netlify /spimg proxy (Cached Egress guard).
    img: require('./utils/supabase-img').proxifySupabaseImage(product.image_url || ''),
  };
}

async function loadProducts() {
  const raw = JSON.parse(fs.readFileSync(findCataloguePath(), 'utf8'));
  const products = raw.map(normalizeRawBook).filter((p) => p.slug && p.title && p.price > 0 && p.img);
  const seen = new Set(products.map((p) => p.slug));

  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data, error } = await supabase
        .from('custom_products')
        .select('slug,title,author,category,description,price_inr,original_price_inr,image_url,tags,is_active')
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
        .limit(100);
      if (!error) {
        for (const row of data || []) {
          const product = normalizeCustomProduct(row);
          if (product.slug && product.title && product.price > 0 && product.img && !seen.has(product.slug)) {
            products.unshift(product);
            seen.add(product.slug);
          }
        }
      }
    } catch (err) {
      console.warn('custom_products unavailable for frequently-bought:', err.message);
    }
  }

  return products;
}

function scoreCandidate(base, candidate, signals) {
  if (!base || !candidate || base.slug === candidate.slug) return -Infinity;
  let score = 0;

  // Evidence first. A real co-purchase outranks every similarity heuristic
  // below it, because it is the only one that is a fact rather than a guess:
  // two customers doing the same thing already beats a shared category, and
  // Vol 1 -> Vol 2 (117 co-buys) has to come top of its page every time.
  // Logarithmic, so a 117 does not need 117x the weight of a 2 to win.
  const together = signals ? coBuyCount(signals, base, candidate) : 0;
  if (together > 0) score += 400 + Math.round(Math.log2(together) * 120);

  // Then popularity. This is what pushes the long tail -- a book with no
  // co-purchase history recommends the thing in its category that people
  // actually buy, instead of whichever title happens to share a word.
  const sold = signals ? unitsSold(signals, candidate) : 0;
  if (sold > 0) score += Math.min(Math.round(Math.log2(sold + 1) * 22), 190);

  const baseCat = String(base.category || '').toLowerCase();
  const candCat = String(candidate.category || '').toLowerCase();
  const baseAuthor = String(base.author || '').toLowerCase();
  const candAuthor = String(candidate.author || '').toLowerCase();

  if (baseCat && candCat && baseCat === candCat) score += 70;
  if (baseCat && candCat && (baseCat.includes('hindi') && candCat.includes('hindi'))) score += 18;
  if (baseCat && candCat && (baseCat.includes('romance') && candCat.includes('romance'))) score += 16;
  if (baseCat && candCat && (baseCat.includes('self') && candCat.includes('self'))) score += 16;
  if (baseAuthor && candAuthor && baseAuthor === candAuthor) score += 55;

  const baseWords = tokenize(`${base.title} ${base.tags} ${base.description}`);
  const candWords = tokenize(`${candidate.title} ${candidate.tags} ${candidate.description}`);
  let overlap = 0;
  for (const word of baseWords) if (candWords.has(word)) overlap++;
  score += Math.min(overlap * 8, 48);

  const diff = Math.abs((base.price || 0) - (candidate.price || 0));
  if (diff <= 75) score += 14;
  else if (diff <= 175) score += 8;
  else if (diff <= 350) score += 3;

  const promoWords = /combo|set|series|bestseller|trending|hindi|self help|romance/i;
  if (promoWords.test(candidate.title) || promoWords.test(candidate.category)) score += 7;
  score += deterministicHash(`${base.slug}:${candidate.slug}`) % 11;
  return score;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const slug = String(event.queryStringParameters?.slug || '')
      .split('/')
      .filter(Boolean)[0]
      .toLowerCase();
    const products = await loadProducts();
    const base = products.find((p) => p.slug === slug || (p.aliases || []).includes(slug)) || null;
    if (!base) {
      // Slug not found — return popular books as fallback instead of 404
      // This prevents "Top resources not found" noise in analytics
      // Unknown slug. Show what actually sells rather than a hash-shuffled
      // three -- this is the response a brand-new or mistyped product gets.
      const signals = loadSignals();
      const fallback = products
        .filter((p) => p.img && p.price > 0)
        .map((product) => ({ product, sold: unitsSold(signals, product) }))
        .sort((a, b) => b.sold - a.sold
          || deterministicHash(slug + a.product.slug) - deterministicHash(slug + b.product.slug));
      const fallbackTop = takeDistinct(fallback, 3, (row) => row.product).map((row) => row.product);
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ current: null, recommendations: fallbackTop, basis: 'bestsellers' }),
      };
    }

    const signals = loadSignals();
    const limit = Math.min(Math.max(Number(event.queryStringParameters?.limit) || 3, 1), 6);
    const exclude = new Set(String(event.queryStringParameters?.exclude || '')
      .split(',').map((v) => v.trim().toLowerCase()).filter(Boolean));

    const ranked = products
      .filter((p) => p.slug !== base.slug && !exclude.has(p.slug) && dedupeKey(p) !== dedupeKey(base))
      .map((product) => ({ product, score: scoreCandidate(base, product, signals) }))
      .filter((row) => Number.isFinite(row.score))
      .sort((a, b) => b.score - a.score);

    const recommendations = takeDistinct(ranked, limit, (row) => row.product).map((row) => row.product);

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        current: base,
        recommendations,
        // Lets the storefront say "frequently bought together" honestly when the
        // data backs it, and something softer when it is only a similar book.
        basis: ranked.length && coBuyCount(signals, base, ranked[0].product) > 0 ? 'co_purchase' : 'similar',
        signals_generated_at: signals.generatedAt,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: err.message || 'Unable to load recommendations' }),
    };
  }
};
