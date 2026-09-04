/**
 * Netlify Function: search-suggest
 * GET /.netlify/functions/search-suggest?q=atomic&limit=8
 *
 * Amazon-style autocomplete: given a query, return the top matching books
 * across BOTH the static catalogue (data/ALL_BOOKS.json, in-memory — zero
 * Supabase egress) AND custom_products (crossword / bookstohome / admin
 * listings). Debounced on the client + durably edge-cached here so repeated
 * prefixes don't keep hitting Supabase.
 *
 * Response: { results: [{ title, author, price, mrp, img, url }] }
 */

const path = require('path');
const fs   = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { makeSlug } = require('./utils/pricing');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const { proxifySupabaseImage } = require('./utils/supabase-img');

function absImg(u) {
  const s = String(u || '');
  if (!s) return '';
  if (s.startsWith('data:')) return s;
  // Supabase-hosted covers go through the Netlify /spimg proxy so suggestion
  // thumbnails don't burn Supabase Cached Egress per keystroke/pageview.
  if (s.startsWith('http')) return proxifySupabaseImage(s);
  return 'https://inkandchai.in' + (s.startsWith('/') ? s : '/' + s);
}
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(); }

// ── Static catalogue index (built once per cold start) ───────────────────────
let _catalog = null;
function getCatalog() {
  if (_catalog) return _catalog;
  const candidates = [
    path.join(__dirname, '..', '..', 'data', 'ALL_BOOKS.json'),
    path.join(process.cwd(), 'data', 'ALL_BOOKS.json'),
    path.join('/var/task', 'data', 'ALL_BOOKS.json'),
  ];
  let raw = null;
  for (const p of candidates) {
    try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch (e) { /* next */ }
  }
  _catalog = [];
  for (const b of (raw || [])) {
    const price = parseFloat(b.price_inr || 0) || 0;
    if (!b.title || price <= 0) continue;
    const slug = makeSlug(b.title || '', b.shopify_id || '').toLowerCase();
    if (!slug) continue;
    _catalog.push({
      title: String(b.title).slice(0, 200),
      author: String(b.author || ''),
      price,
      mrp: parseFloat(b.original_price_inr || 0) || 0,
      img: absImg(b.image_url),
      url: `/product/${slug}/`,
      _hay: norm(`${b.title} ${b.author || ''}`),
    });
  }
  return _catalog;
}

function scoreMatch(hay, title, q) {
  if (hay.startsWith(q)) return 100;                 // title starts with query
  if (title.toLowerCase().startsWith(q)) return 95;
  const idx = hay.indexOf(q);
  if (idx === 0) return 90;
  if (idx > 0) return 60 - Math.min(40, idx);        // earlier match = better
  // all words present?
  const words = q.split(' ').filter(Boolean);
  if (words.length > 1 && words.every(w => hay.includes(w))) return 40;
  return -1;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'GET only' }) };

  const q = norm((event.queryStringParameters || {}).q || '');
  const limit = Math.min(12, Math.max(1, parseInt((event.queryStringParameters || {}).limit || '8', 10) || 8));
  if (q.length < 2) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ results: [] }) };
  }

  const headers = {
    ...CORS,
    'Cache-Control': 'public, max-age=300',
    // Durable edge cache — a given query hits Supabase at most ~once/hour.
    'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=3600, stale-while-revalidate=86400',
    // Purged the moment an admin save changes this (utils/purge-cache.js).
    'Netlify-Cache-Tag': 'products',
  };

  try {
    // 1) Static catalogue (in-memory, no egress)
    const scored = [];
    for (const b of getCatalog()) {
      const s = scoreMatch(b._hay, b.title, q);
      if (s >= 0) scored.push({ ...b, _score: s });
    }

    // 2) custom_products (Supabase) — title match, capped
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      try {
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
        const safe = q.replace(/[%,()]/g, ' ').trim();
        if (safe) {
          const { data } = await supabase
            .from('custom_products')
            .select('slug,title,author,price_inr,original_price_inr,image_url')
            .eq('is_active', true)
            .ilike('title', `%${safe}%`)
            .limit(12);
          for (const r of (data || [])) {
            const price = parseFloat(r.price_inr || 0) || 0;
            if (!r.title || price <= 0) continue;
            const hay = norm(`${r.title} ${r.author || ''}`);
            scored.push({
              title: String(r.title).slice(0, 200),
              author: String(r.author || ''),
              price,
              mrp: parseFloat(r.original_price_inr || 0) || 0,
              img: absImg(r.image_url),
              url: `/product/${r.slug}/`,
              _score: scoreMatch(hay, r.title, q),
            });
          }
        }
      } catch (e) { console.warn('search-suggest custom_products:', e.message); }
    }

    // Rank, de-dupe by url, take top N
    const seen = new Set();
    const results = scored
      .sort((a, b) => b._score - a._score)
      .filter(r => { if (seen.has(r.url)) return false; seen.add(r.url); return true; })
      .slice(0, limit)
      .map(({ title, author, price, mrp, img, url }) => ({ title, author, price, mrp: mrp > price ? mrp : 0, img, url }));

    return { statusCode: 200, headers, body: JSON.stringify({ results }) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ results: [], warning: err.message }) };
  }
};
