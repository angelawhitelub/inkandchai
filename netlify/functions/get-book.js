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
  if (img.startsWith('http')) return img;
  return 'https://inkandchai.in' + img;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const id = (event.queryStringParameters?.id || '').toLowerCase().trim();
  if (!id) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing id' }) };
  }

  try {
    const index = getIndex();
    const book = index[id];
    if (!book) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Book not found' }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify(book) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
