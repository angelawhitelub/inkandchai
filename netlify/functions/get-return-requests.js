/**
 * Netlify Function: get-return-requests
 * GET /.netlify/functions/get-return-requests
 *
 * Admin endpoint — fetch all return requests from Supabase.
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const adminKey = process.env.ADMIN_SECRET;
  if (adminKey && event.headers['x-admin-key'] !== adminKey) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data, error } = await supabase
      .from('return_requests')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ returns: data || [] }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
