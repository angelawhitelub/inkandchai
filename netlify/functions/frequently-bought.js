const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=300, s-maxage=900',
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

function makeSlug(title, shopifyId) {
  const sid = String(shopifyId || '');
  if (sid === 'CUSTOM-KINGS-OF-SIN-COMPLETE-SET-6-AH') return 'kings-of-sin-series-complete-set-6-books-ana-huang';
  if (sid === 'CUSTOM-HINDI-BESTSELLERS-COMBO-5') return '5-hindi-bestsellers-combo-set-of-5-books-MBO-5';
  if (sid === 'CUSTOM-100M-HINDI-COMBO-2') return '100m-leads-hindi-100m-offers-hindi-combo-2-books';
  if (sid === 'CUSTOM-GOGGINS-COMBO-HI') return 'david-goggins-combo-hindi-cant-hurt-me-never-finished';
  if (sid === 'CUSTOM-MOTHER-MARY-COMES-TO-ME-HI-ARUNDHATI-ROY') return 'mother-mary-comes-to-me-hindi-edition-arundhati-roy';
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
    img: product.image_url || '',
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
      return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Product not found' }) };
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
