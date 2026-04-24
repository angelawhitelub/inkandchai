/**
 * Netlify Function: get-orders
 * GET /.netlify/functions/get-orders
 * Admin endpoint — returns all orders. Requires X-Admin-Key header.
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // ── Auth check ────────────────────────────────────────────────────────────
  const adminKey   = process.env.ADMIN_SECRET;
  const sentKey    = event.headers['x-admin-key'] || event.queryStringParameters?.key;
  if (!adminKey || sentKey !== adminKey) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are not set in Netlify.' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const page  = parseInt(event.queryStringParameters?.page  || '1', 10);
    const limit = parseInt(event.queryStringParameters?.limit || '50', 10);
    const from  = (page - 1) * limit;

    const status = event.queryStringParameters?.status;
    let query = supabase
      .from('orders')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1);

    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;
    if (error) throw error;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ orders: data, total: count, page, limit }),
    };
  } catch (err) {
    console.error('get-orders error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
