/**
 * Netlify Function: get-my-orders
 * GET /.netlify/functions/get-my-orders
 *
 * Fetches orders for the authenticated user. Matches BOTH email and phone — many
 * Indian customers check out without an email, so phone is the more reliable key.
 * Uses service key to bypass RLS — safe because we validate identity first (JWT).
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

// Normalise to the last 10 digits — orders may store phone as +91…, 91…, or raw.
function last10(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

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
  let lookupPhone10 = null;

  // ── Strategy 1: JWT in Authorization header ──────────────────────────────
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (token) {
    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (!error && user) {
        if (user.email) lookupEmail = user.email.toLowerCase();
        // Pull the phone the customer registered via their profile (auth.users
        // doesn't always have it for email-based signups).
        const metaPhone = user.user_metadata?.phone || user.phone || '';
        if (metaPhone) lookupPhone10 = last10(metaPhone);
        if (!lookupPhone10) {
          const { data: profile } = await supabase
            .from('profiles').select('phone').eq('id', user.id).maybeSingle();
          if (profile?.phone) lookupPhone10 = last10(profile.phone);
        }
      }
    } catch (e) { /* fall through */ }
  }

  // ── Strategy 2: email or phone query param (guest-tracking fallback) ──────
  const qs = event.queryStringParameters || {};
  if (!lookupEmail   && qs.email) lookupEmail   = String(qs.email).trim().toLowerCase();
  if (!lookupPhone10 && qs.phone) lookupPhone10 = last10(qs.phone);

  if (!lookupEmail && !lookupPhone10) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Not authenticated' }) };
  }

  try {
    // Match by email OR phone. customer_phone format varies, so wildcard the last
    // 10 digits ('%9876543210') to catch +919876543210 / 919876543210 / 9876543210.
    const filters = [];
    if (lookupEmail)   filters.push(`customer_email.ilike.${lookupEmail}`);
    if (lookupPhone10) filters.push(`customer_phone.ilike.%${lookupPhone10}`);

    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .or(filters.join(','))
      .order('created_at', { ascending: false })
      .limit(30);

    if (error) throw error;

    const orders = data || [];

    // Fetch return requests IN PARALLEL (was sequential — added ~300ms latency)
    if (orders.length) {
      const orderIds = orders.map(o => o.id);
      const [{ data: returns }] = await Promise.all([
        supabase.from('return_requests').select('order_id, status').in('order_id', orderIds),
      ]);
      const returnMap = {};
      (returns || []).forEach(r => { returnMap[r.order_id] = r.status; });
      orders.forEach(o => { if (returnMap[o.id]) o.return_request_status = returnMap[o.id]; });
    }

    // Cache: allow CDN/browser to cache for 30s — orders don't change every second
    const headers = {
      ...CORS,
      'Cache-Control': 'private, max-age=30, stale-while-revalidate=60',
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ orders }),
    };
  } catch (err) {
    console.error('get-my-orders error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
