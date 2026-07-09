/**
 * Netlify Function: get-book
 * GET /.netlify/functions/get-book?id=SLUG
 *
 * Returns lightweight book data for a given product slug.
 * Used by the checkout page to pre-fill the cart when arriving
 * from Google Shopping with ?buy=SLUG in the URL.
 */

const path = require('path');
const fs   = require('fs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

// For successful book lookups only — feeds checkout ?buy= deep-links (incl.
// Google Merchant traffic). Book data + price change rarely, and product-page.js
// already caches the same data for 1h, so mirror that at Netlify's edge to keep
// Supabase out of the hot path. Never applied to null/error responses.
const CACHED = {
  ...CORS,
  'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=3600, stale-while-revalidate=86400',
  'Cache-Control': 'public, max-age=300',
};

// Load and index books once per cold start
let _index = null;
function getIndex() {
  if (_index) return _index;
  const filePath = path.join(__dirname, '../../data/ALL_BOOKS.json');
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  _index = {};
  for (const b of raw) {
    const slug = slugFromUrl(b.url || '');
    if (!slug) continue;
    const price = parseFloat(b.price_inr || 0) || 0;
    const origPrice = parseFloat(b.original_price_inr || 0) || 0;
    _index[slug.toLowerCase()] = {
      id:    slug,
      slug:  slug,
      title: b.title || '',
      author: b.author || '',
      price: price,
      orig_price: origPrice > price ? origPrice : 0,
      img:   localOrAbsolute(b.image_url || ''),
      url:   `/product/${slug}/`,
    };
  }
  return _index;
}

function slugFromUrl(url) {
  // e.g. https://inkandchai.in/product/some-slug/ → some-slug
  const m = String(url).match(/\/product\/([^/?#]+)/);
  return m ? m[1] : '';
}

function localOrAbsolute(img) {
  if (!img) return '';
  // Supabase-hosted covers → Netlify /spimg proxy (Cached Egress guard).
  if (img.startsWith('http')) return require('./utils/supabase-img').proxifySupabaseImage(img);
  return 'https://inkandchai.in' + img;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const rawId = (event.queryStringParameters?.id || '').toLowerCase().trim();
  if (!rawId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing id' }) };
  }
  // Product feeds emit g:id as "cp-<slug>" for custom_products (and the static
  // catalogue uses the bare slug). Accept both — strip a leading "cp-".
  const slug = rawId.replace(/^cp-/, '');

  try {
    const index = getIndex();
    const book = index[rawId] || index[slug];
    if (book) {
      return { statusCode: 200, headers: CACHED, body: JSON.stringify(book) };
    }

    // Not in the static catalogue — try custom_products (crossword / bookstohome
    // / admin listings), which is where most feed items live.
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      const { createClient } = require('@supabase/supabase-js');
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data } = await supabase
        .from('custom_products')
        .select('slug,title,author,price_inr,original_price_inr,image_url,is_active')
        .eq('slug', slug)
        .eq('is_active', true)
        .maybeSingle();
      if (data) {
        const price = parseFloat(data.price_inr || 0) || 0;
        const orig  = parseFloat(data.original_price_inr || 0) || 0;
        return { statusCode: 200, headers: CACHED, body: JSON.stringify({
          id: data.slug, slug: data.slug, title: data.title || '',
          author: data.author || '', price,
          orig_price: orig > price ? orig : 0,
          img: localOrAbsolute(data.image_url || ''),
          url: `/product/${data.slug}/`,
        }) };
      }
    }

    // Return null book rather than 404 to avoid analytics noise
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ book: null }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
