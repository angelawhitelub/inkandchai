/**
 * Netlify Function: get-reviews
 * GET /.netlify/functions/get-reviews?slug=PRODUCT_SLUG
 * GET /.netlify/functions/get-reviews?pending=1   (admin — all pending reviews)
 *
 * Returns approved reviews for a product slug.
 */

const { createClient } = require('@supabase/supabase-js');

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

  const { data, error } = await supabase
    .from('product_reviews')
    .select('id, customer_name, rating, comment, created_at, verified_buyer')
    .eq('product_slug', slug)
    .eq('approved', true)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ reviews: data || [] }),
  };
};
