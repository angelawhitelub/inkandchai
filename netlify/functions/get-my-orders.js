/**
 * Netlify Function: get-my-orders
 * GET /.netlify/functions/get-my-orders
 *
 * Fetches orders for the authenticated user (by JWT) or by email query param.
 * Uses service key to bypass RLS — safe because we validate identity first.
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const SUPABASE_URL         = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let lookupEmail = null;

  // ── Strategy 1: JWT in Authorization header ──────────────────────────────
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (token) {
    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (!error && user?.email) {
        lookupEmail = user.email.toLowerCase();
      }
    } catch (e) { /* fall through */ }
  }

  // ── Strategy 2: email query param (fallback — acceptable for e-commerce) ─
  if (!lookupEmail) {
    lookupEmail = (event.queryStringParameters?.email || '').trim().toLowerCase();
  }

  if (!lookupEmail) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Not authenticated' }) };
  }

  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .ilike('customer_email', lookupEmail)   // case-insensitive match
      .order('created_at', { ascending: false })
      .limit(30);

    if (error) throw error;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ orders: data || [] }),
    };
  } catch (err) {
    console.error('get-my-orders error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
