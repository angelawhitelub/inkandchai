/**
 * Netlify Function: admin-product-search
 * GET /.netlify/functions/admin-product-search?q=...&limit=12
 *
 * Search the WHOLE active catalogue, for admin tools that need to pick a
 * product by name.
 *
 * WHY NOT catalog-search
 * ----------------------
 * catalog-search looks like a general search and is not. It exists to serve the
 * public /books browse grid, and is hard-scoped to the two browse-only
 * catalogues that are deliberately kept off the homepage feed:
 *
 *     .or('tags.ilike.%crossword-catalog%,tags.ilike.%99bookstores-catalog%')
 *
 * That covers 26,423 of 27,561 active products, so it looks like it searches
 * everything right up until it does not. The 1,138 it cannot see are the
 * publisher-sourced titles -- exactly the books worth putting on a banner.
 * Banner Studio was wired to it and could not find "Protocols: An Operating
 * Manual for the Human Body" at all, even though the book is active, priced and
 * in the custom feed.
 *
 * Widening catalog-search was the wrong fix: it is unauthenticated and renders
 * to every visitor, so a scope flag there is one typo away from changing what
 * the public grid shows. This is a separate, admin-only endpoint instead.
 *
 * Title AND author are searched, because "Elle Kennedy" is how you look for a
 * series you intend to feature.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { proxifySupabaseImage } = require('./utils/supabase-img');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const MAX_LIMIT = 24;
// Over-fetch so ranking has something to rank; an ilike '%term%' puts an exact
// title and an incidental mid-sentence mention in the same undifferentiated pile.
const CANDIDATES = 80;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  const block = requireAdmin(event, CORS); if (block) return block;

  const qp = event.queryStringParameters || {};
  const q = String(qp.q || '').trim().slice(0, 120);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(qp.limit || '12', 10) || 12));
  if (q.length < 2) return json(200, { books: [], total: 0 });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Supabase is not configured on this deploy.' });
  }

  // PostgREST reads these as filter syntax, so they cannot reach the query.
  const safe = q.replace(/[%,()*]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!safe) return json(200, { books: [], total: 0 });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let rows;
  try {
    const { data, error } = await supabase
      .from('custom_products')
      .select('slug,title,author,category,price_inr,original_price_inr,image_url')
      .eq('is_active', true)
      .or(`title.ilike.%${safe}%,author.ilike.%${safe}%`)
      .limit(CANDIDATES);
    if (error) throw error;
    rows = data || [];
  } catch (e) {
    console.error('[admin-product-search]', e.message);
    return json(500, { error: e.message });
  }

  // Exact title, then title starting with the term, then a title match
  // anywhere, then author-only. Shortest title breaks the tie, so "Protocols"
  // beats "The Protocols of ... Volume II" for a one-word search.
  const needle = safe.toLowerCase();
  const score = (b) => {
    const t = String(b.title || '').toLowerCase();
    if (t === needle) return 0;
    if (t.startsWith(needle)) return 1;
    if (t.includes(needle)) return 2;
    return 3;
  };
  rows.sort((a, b) => score(a) - score(b) || String(a.title).length - String(b.title).length);

  const books = rows.slice(0, limit).map(r => ({
    slug: r.slug,
    title: r.title,
    author: r.author || '',
    category: r.category || '',
    price: r.price_inr,
    original_price: r.original_price_inr || null,
    img: proxifySupabaseImage(r.image_url),
  }));

  return json(200, { books, total: books.length, truncated: rows.length >= CANDIDATES });
};
