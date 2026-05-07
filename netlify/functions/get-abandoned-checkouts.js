/**
 * Netlify Function: get-abandoned-checkouts
 * GET /.netlify/functions/get-abandoned-checkouts
 *
 * Admin endpoint for checkout leads that did not convert.
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const adminKey = process.env.ADMIN_SECRET;
  const sentKey = event.headers['x-admin-key'] || event.queryStringParameters?.key;
  if (!adminKey || sentKey !== adminKey) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are not set in Netlify.' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const page = Math.max(1, parseInt(event.queryStringParameters?.page || '1', 10));
    const limit = Math.min(500, Math.max(1, parseInt(event.queryStringParameters?.limit || '100', 10)));
    const minAgeMinutes = Math.max(0, parseInt(event.queryStringParameters?.min_age_minutes || '30', 10));
    const from = (page - 1) * limit;
    const cutoff = new Date(Date.now() - minAgeMinutes * 60 * 1000).toISOString();

    let query = supabase
      .from('abandoned_checkouts')
      .select('*', { count: 'exact' })
      .eq('status', 'open')
      .lte('updated_at', cutoff)
      .order('updated_at', { ascending: false })
      .range(from, from + limit - 1);

    const q = String(event.queryStringParameters?.q || '').trim();
    if (q) {
      query = query.or(`customer_name.ilike.%${q}%,customer_email.ilike.%${q}%,customer_phone.ilike.%${q}%`);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ checkouts: data || [], total: count || 0, page, limit, min_age_minutes: minAgeMinutes }),
    };
  } catch (err) {
    console.error('get-abandoned-checkouts error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
