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
const CUSTOM_SLUGS = {
  'CUSTOM-KINGS-OF-SIN-COMPLETE-SET-6-AH':        'kings-of-sin-series-complete-set-6-books-ana-huang',
  'CUSTOM-HINDI-BESTSELLERS-COMBO-5':              '5-hindi-bestsellers-combo-set-of-5-books-MBO-5',
  'CUSTOM-100M-HINDI-COMBO-2':                     '100m-leads-hindi-100m-offers-hindi-combo-2-books',
  'CUSTOM-GOGGINS-COMBO-HI':                       'david-goggins-combo-hindi-cant-hurt-me-never-finished',
  'CUSTOM-MOTHER-MARY-COMES-TO-ME-HI-ARUNDHATI-ROY': 'mother-mary-comes-to-me-hindi-edition-arundhati-roy',
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
  'CUSTOM-ANA-HUANG-KINGS-SIN-1-3':               'ana-huang-kings-of-sin-series-books-1-2-3',
  'CUSTOM-OFF-CAMPUS-5-ELLE-KENNEDY':              'off-campus-complete-5-book-collection-elle-kennedy',
  'CUSTOM-PSYCH-MONEY-THINKING-FAST-HINDI-2':      'psychology-of-money-hindi-thinking-fast-slow-hindi-combo-2-books',
  'CUSTOM-OFF-CAMPUS-COMBO-3-EK':                  'the-deal-the-mistake-the-score-elle-kennedy-off-campus-combo',
  'CUSTOM-TAIWAN-TRAVELOGUE':                      'taiwan-travelogue-yang-shuang-zi-international-booker-prize',
};

function makeSlug(title, shopifyId) {
  const sid = String(shopifyId || '');
  if (CUSTOM_SLUGS[sid]) return CUSTOM_SLUGS[sid];
  const base = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 55);
  const suffix = sid.slice(-5);
  return suffix ? `${base}-${suffix}` : base;
}

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

function scoreCandidate(base, candidate) {
  if (!base || !candidate || base.slug === candidate.slug) return -Infinity;
  let score = 0;
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
      const fallback = products
        .filter(p => p.img && p.price > 0)
        .sort((a, b) => deterministicHash(slug + b.slug) - deterministicHash(slug + a.slug))
        .slice(0, 3);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ current: null, recommendations: fallback }) };
    }

    const recommendations = products
      .filter((p) => p.slug !== base.slug)
      .map((product) => ({ product, score: scoreCandidate(base, product) }))
      .filter((row) => Number.isFinite(row.score))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((row) => row.product);

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ current: base, recommendations }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: err.message || 'Unable to load recommendations' }),
    };
  }
};
