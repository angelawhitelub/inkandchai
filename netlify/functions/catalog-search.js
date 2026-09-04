/**
 * Netlify Function: catalog-search
 * GET /.netlify/functions/catalog-search?q=&page=1&per_page=24&sort=new
 *
 * Server-paginated browse/search over the large crossword.in catalogue
 * (custom_products tagged 'crossword-catalog'). Returns a SMALL page of card
 * fields at a time — this is what keeps 8k+ books off the per-pageview
 * homepage feed and out of Supabase egress trouble.
 *
 * Response: { books:[{slug,title,price,original_price,img,no_cod}], total, page, per_page, pages }
 * Cached at the edge for 5 min (catalogue changes rarely).
 */

const { createClient } = require('@supabase/supabase-js');
const { proxifySupabaseImage } = require('./utils/supabase-img');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const MAX_PER_PAGE = 48;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ books: [], total: 0, page: 1, per_page: 24, pages: 0 }) };
  }

  const qp       = event.queryStringParameters || {};
  const q        = String(qp.q || '').trim().slice(0, 120);
  const page     = Math.max(1, parseInt(qp.page || '1', 10) || 1);
  const perPage  = Math.min(MAX_PER_PAGE, Math.max(1, parseInt(qp.per_page || '24', 10) || 24));
  const sort     = String(qp.sort || 'new');
  const from     = (page - 1) * perPage;
  const to       = from + perPage - 1;

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    let query = supabase
      .from('custom_products')
      .select('slug,title,price_inr,original_price_inr,image_url,tags', { count: 'exact' })
      .eq('is_active', true)
      // The /books browse grid serves the big browse-only catalogues that are
      // kept off the homepage feed: crossword.in + 99bookstores.
      .or('tags.ilike.%crossword-catalog%,tags.ilike.%99bookstores-catalog%');

    if (q) {
      // Escape PostgREST filter special chars in the user term.
      const safe = q.replace(/[%,()]/g, ' ').trim();
      if (safe) query = query.ilike('title', `%${safe}%`);
    }

    if (sort === 'price_asc')       query = query.order('price_inr', { ascending: true });
    else if (sort === 'price_desc') query = query.order('price_inr', { ascending: false });
    else if (sort === 'title')      query = query.order('title', { ascending: true });
    else                            query = query.order('updated_at', { ascending: false });

    const { data, count, error } = await query.range(from, to);
    if (error) throw error;

    const books = (data || []).map(r => ({
      slug: r.slug,
      title: r.title,
      price: r.price_inr,
      original_price: r.original_price_inr || null,
      // Route supabase-hosted covers through the Netlify /spimg proxy — the
      // /books grid renders these to every visitor, and raw supabase.co URLs
      // burn Cached Egress per pageview. External (crossword.in) URLs pass through.
      img: proxifySupabaseImage(r.image_url || ''),
      no_cod: /(?:^|,)\s*no-cod\s*(?:,|$)/i.test(String(r.tags || '')),
    }));

    const total = count || 0;
    return {
      statusCode: 200,
      headers: {
        ...CORS,
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=60',
        // Durable shared edge cache — the /books browse+search results (unique
        // per page/query) are fetched from Supabase at most ~once/hour each,
        // rather than on every crawler request across 4.5k pages.
        'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=3600, stale-while-revalidate=86400',
        // Purged the moment an admin save changes this (utils/purge-cache.js).
        'Netlify-Cache-Tag': 'products',
      },
      body: JSON.stringify({ books, total, page, per_page: perPage, pages: Math.ceil(total / perPage) }),
    };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ books: [], total: 0, page, per_page: perPage, pages: 0, warning: err.message }) };
  }
};
