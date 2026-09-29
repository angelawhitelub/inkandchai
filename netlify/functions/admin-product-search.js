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
 *
 * TWO SOURCES, EACH WORD SEPARATELY
 * ---------------------------------
 * custom_products is only the admin-created and imported listings. The ~5,000
 * baked catalogue books (data/ALL_BOOKS.json -- "The Love Hypothesis by Ali
 * Hazelwood" among them) are not in it, so the eBooks panel answered "Nothing
 * matches that" for a book with a live product page. Both are searched now.
 *
 * And the query is split into words, each of which must appear in the title or
 * the author. Matching the whole string meant "The Love Hypothesis by Ali
 * Hazelwood" only found a title containing that exact run of words -- typing
 * the author after the title, the natural way, found nothing.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { proxifySupabaseImage } = require('./utils/supabase-img');
const { makeSlug } = require('./utils/pricing');
const CATALOGUE = require('../../data/ALL_BOOKS.json');

// Words that carry no signal in a title search ("… by Ali Hazelwood").
const STOP = new Set(['by', 'the', 'a', 'an', 'of', 'and', '&']);

/** Search words: lowercased, stop words dropped, at most 6 so the query stays small. */
function searchWords(q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(w => w.length >= 2 && !STOP.has(w));
  return [...new Set(words)].slice(0, 6);
}

/** Every word appears in the title or the author. */
function matchesAll(book, words) {
  const hay = `${book.title || ''} ${book.author || ''}`.toLowerCase();
  return words.every(w => hay.includes(w));
}

/** Catalogue books shaped like custom_products rows, one per product. */
let _catalogue = null;
function catalogueRows() {
  if (_catalogue) return _catalogue;
  const seen = new Set();
  _catalogue = [];
  for (const b of Array.isArray(CATALOGUE) ? CATALOGUE : []) {
    const sid = String(b.shopify_id || '');
    if (!sid || !b.title || seen.has(sid)) continue;
    seen.add(sid);
    _catalogue.push({
      slug: makeSlug(b.title, sid), title: b.title, author: b.author || '',
      category: b.category || '', price_inr: b.price_inr, original_price_inr: b.original_price_inr,
      image_url: b.image_url || '', source: 'catalogue',
    });
  }
  return _catalogue;
}

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

  // Every word must match (each .or() is ANDed with the others). A query of
  // only stop words falls back to the whole string.
  const words = searchWords(safe);
  const terms = words.length ? words : [safe.toLowerCase()];

  let rows;
  try {
    let query = supabase
      .from('custom_products')
      .select('slug,title,author,category,price_inr,original_price_inr,image_url')
      .eq('is_active', true);
    for (const w of terms) query = query.or(`title.ilike.%${w}%,author.ilike.%${w}%`);
    const { data, error } = await query.limit(CANDIDATES);
    if (error) throw error;
    rows = data || [];
  } catch (e) {
    console.error('[admin-product-search]', e.message);
    return json(500, { error: e.message });
  }

  // The baked catalogue, which custom_products does not contain. A slug in
  // both is the custom row's (it is the live listing).
  const have = new Set(rows.map(r => String(r.slug || '').toLowerCase()));
  for (const b of catalogueRows()) {
    if (rows.length >= CANDIDATES * 2) break;
    if (have.has(b.slug.toLowerCase()) || !matchesAll(b, terms)) continue;
    rows.push(b);
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
    // Every word in the title itself beats a match that needed the author.
    if (terms.every(w => t.includes(w))) return 3;
    return 4;
  };
  rows.sort((a, b) => score(a) - score(b) || String(a.title).length - String(b.title).length);

  // Drop books whose page has been taken down. is_active=true is not enough:
  // a takedown is recorded in deleted_products and enforced by the Worker as a
  // 410, and the custom_products row is left alone -- so a dead book still
  // looked alive here. That is how an eBook came to be attached to a product
  // page that answers 410 Gone, and how Banner Studio could feature one.
  // Best-effort: if the table is missing the search behaves as it always did.
  try {
    const slugs = rows.map(r => r.slug).filter(Boolean);
    if (slugs.length) {
      const { data: gone, error } = await supabase
        .from('deleted_products').select('slug').in('slug', slugs);
      if (!error && gone && gone.length) {
        const dead = new Set(gone.map(g => String(g.slug || '').toLowerCase()));
        rows = rows.filter(r => !dead.has(String(r.slug || '').toLowerCase()));
      }
    }
  } catch (e) {
    console.warn('[admin-product-search] takedown filter:', e.message);
  }

  const books = rows.slice(0, limit).map(r => ({
    slug: r.slug,
    title: r.title,
    author: r.author || '',
    category: r.category || '',
    price: r.price_inr,
    original_price: r.original_price_inr || null,
    img: proxifySupabaseImage(r.image_url),
    source: r.source || 'custom',
  }));

  return json(200, { books, total: books.length, truncated: rows.length >= CANDIDATES });
};

exports._test = { searchWords, matchesAll, catalogueRows };
