/**
 * Netlify Function: get-reviews
 * GET /.netlify/functions/get-reviews?slug=PRODUCT_SLUG
 * GET /.netlify/functions/get-reviews?pending=1   (admin — all pending reviews)
 *
 * Returns approved reviews for a product slug.
 */

const { createClient } = require('@supabase/supabase-js');
const { cleanPhotoUrls, isMissingPhotosColumn } = require('./utils/review-photos');
const { requireAdmin } = require('./utils/admin-auth');
const httpsOrNull = (u) => (/^https:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : null);

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const params = event.queryStringParameters || {};

  // The two list views return whole rows (customer email, order id) and are
  // for the admin Reviews tab only. They used to answer anyone.
  if (params.pending === '1' || params.all === '1') {
    const block = requireAdmin(event, CORS);
    if (block) return block;
  }

  // Admin: get all pending reviews
  if (params.pending === '1') {
    const { data, error } = await supabase
      .from('product_reviews')
      .select('*')
      .eq('approved', false)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ reviews: data || [] }) };
  }

  // Admin: get all reviews (approved + pending)
  if (params.all === '1') {
    const { data, error } = await supabase
      .from('product_reviews')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ reviews: data || [] }) };
  }

  const slug = params.slug || '';
  if (!slug) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'slug required' }) };

  // photos needs sql/product_reviews_photos.sql; until it has run, read the
  // reviews without it rather than showing none.
  const read = (cols) => supabase
    .from('product_reviews')
    .select(cols)
    .eq('product_slug', slug)
    .eq('approved', true)
    .order('created_at', { ascending: false })
    .limit(50);
  const BASE = 'id, customer_name, rating, comment, created_at, verified_buyer';
  let { data, error } = await read(BASE + ', photos, video_url, video_poster');
  if (error && isMissingPhotosColumn(error)) ({ data, error } = await read(BASE));
  if (data) data = data.map((r) => ({ ...r, photos: cleanPhotoUrls(r.photos), video_url: httpsOrNull(r.video_url), video_poster: httpsOrNull(r.video_poster) }));

  if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };

  // This fires on EVERY product-page load (real visitors + Google crawling
  // thousands of pages), and reviews change rarely. Cache the response at
  // Netlify's edge for 1h (durable) with a 24h stale-while-revalidate window
  // so Supabase gets hit at most ~once/hour/edge/slug instead of every view.
  // A newly-approved review shows up within the hour (or admin can purge).
  return {
    statusCode: 200,
    headers: {
      ...CORS,
      'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=3600, stale-while-revalidate=86400',
      // Purged the moment an admin save changes this (utils/purge-cache.js).
      'Netlify-Cache-Tag': 'reviews',
      'Cache-Control': 'public, max-age=300',
    },
    body: JSON.stringify({ reviews: data || [] }),
  };
};
