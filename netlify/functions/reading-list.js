/**
 * Netlify Function: reading-list   (public, read-only)
 * GET /.netlify/functions/reading-list?slug=<list slug>   (a hand-written list)
 * GET /.netlify/functions/reading-list?slugs=a,b,c        (any books, at most 200;
 *     the Worker uses this for generated lists and the index)
 *
 * The books a reading list (utils/reading-lists) needs, at the till's price:
 *   { books: { "<slug>": { price, mrp, img, title, author } } }
 * Only books the till prices and sells are returned: sold out, taken down,
 * inactive or unpriced books are left out, so the page never shows them.
 * The Worker renders /best-books/ pages from this.
 */

const { createClient } = require('@supabase/supabase-js');
const { resolveCartPrices, makeSlug } = require('./utils/pricing');
const { listFor, allPickSlugs } = require('./utils/reading-lists');
const { proxifySupabaseImage } = require('./utils/supabase-img');
const ALL_BOOKS = require('../../data/ALL_BOOKS.json');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const TTL_MS = 10 * 60 * 1000;
const _cache = new Map();

const slugFromUrl = (url) => ((String(url || '').match(/\/product\/([^/?#]+)/) || [])[1] || '').toLowerCase();
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : 0; };

let _catalogue = null;
function catalogue() {
  if (_catalogue) return _catalogue;
  _catalogue = new Map();
  for (const b of ALL_BOOKS) {
    const info = { title: b.title || '', author: b.author || '', img: b.image_url || '', mrp: num(b.original_price_inr) };
    for (const s of [makeSlug(b.title, b.shopify_id), slugFromUrl(b.url)]) {
      if (s && !_catalogue.has(s.toLowerCase())) _catalogue.set(s.toLowerCase(), info);
    }
  }
  return _catalogue;
}

async function booksFor(slugs, supabase, { price = resolveCartPrices } = {}) {
  const info = {};
  const cat = catalogue();
  const custom = [];
  for (const s of slugs) {
    if (cat.has(s)) info[s] = cat.get(s);
    else custom.push(s);
  }
  if (custom.length && supabase) {
    for (let i = 0; i < custom.length; i += 150) {
      const { data, error } = await supabase.from('custom_products')
        .select('slug,title,author,image_url,original_price_inr,is_active')
        .eq('is_active', true).in('slug', custom.slice(i, i + 150));
      if (error) throw new Error(error.message);
      for (const r of data || []) {
        info[String(r.slug).toLowerCase()] = {
          title: r.title || '', author: r.author || '', img: proxifySupabaseImage(r.image_url || ''), mrp: num(r.original_price_inr),
        };
      }
    }
  }
  const wanted = Object.keys(info);
  if (!wanted.length) return {};
  const { cart } = await price(wanted.map((slug) => ({ slug, qty: 1 })), supabase);
  const books = {};
  for (const line of cart || []) {
    const s = String(line.slug || '').toLowerCase();
    if (!info[s] || line._sold_out || line._removed || !(Number(line.price) > 0)) continue;
    books[s] = { ...info[s], price: Number(line.price) };
  }
  return books;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const q = event.queryStringParameters || {};
  const list = q.slug ? listFor(q.slug) : null;
  if (q.slug && !list) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'No such list' }) };
  const asked = q.slugs ? [...new Set(String(q.slugs).split(',').map((s) => s.trim().toLowerCase()).filter((s) => /^[\w-]{1,200}$/.test(s)))].slice(0, 200) : null;
  const key = list ? list.slug : asked ? asked.slice().sort().join(',') : '*';
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return { statusCode: 200, headers: { ...CORS, 'Cache-Control': 'public, max-age=600' }, body: hit.body };
  }
  try {
    const slugs = list ? [...new Set(list.picks.map((p) => p.slug.toLowerCase()))] : asked || allPickSlugs();
    const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
      ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY) : null;
    const body = JSON.stringify({ books: await booksFor(slugs, supabase) });
    if (_cache.size > 300) _cache.clear();
    _cache.set(key, { at: Date.now(), body });
    return { statusCode: 200, headers: { ...CORS, 'Cache-Control': 'public, max-age=600' }, body };
  } catch (err) {
    console.error('reading-list:', err && err.message);
    if (hit) return { statusCode: 200, headers: CORS, body: hit.body };   // stale beats empty
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: 'Unavailable' }) };
  }
};

exports.booksFor = booksFor;
exports._test = { booksFor, catalogue };
