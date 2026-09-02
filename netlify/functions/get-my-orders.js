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
  // Orders claimed through link-order. Checkout records one email, people sign
  // in with another, and this is the only thread tying the two together.
  let lookupUserId = null;

  // ── Strategy 1: JWT in Authorization header ──────────────────────────────
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (token) {
    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (!error && user) {
        lookupUserId = user.id;
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

  // Guests must use /track-order (id + email/phone proof). Allowing ?email= or
  // ?phone= here let anyone scrape another customer's full order history by
  // enumerating 10-digit phone numbers — a customer-database leak.
  if (!lookupEmail && !lookupPhone10 && !lookupUserId) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Not authenticated' }) };
  }

  try {
    // Match by email OR phone. customer_phone is stored in many formats — raw
    // 10-digit, +91…, '87994 81113' (with a space), etc. — so we widen the SQL
    // search and then normalise to digits in JS for the phone match.
    let orders = [];
    // Explicitly linked orders first — these were claimed with the same proof
    // /track/ demands, so they belong here whatever address checkout recorded.
    if (lookupUserId) {
      const { data, error } = await supabase
        .from('orders').select('*')
        .eq('user_id', lookupUserId)
        .order('created_at', { ascending: false }).limit(60);
      if (error) throw error;
      orders = data || [];
    }
    if (lookupEmail) {
      const { data, error } = await supabase
        .from('orders').select('*')
        .ilike('customer_email', lookupEmail)
        .order('created_at', { ascending: false }).limit(60);
      if (error) throw error;
      const seen = new Set(orders.map(o => o.id));
      for (const o of data || []) if (!seen.has(o.id)) { orders.push(o); seen.add(o.id); }
    }
    if (lookupPhone10) {
      // Two passes for safety: contiguous (cheap, indexable) + last-4-digit prefilter
      // (catches phones with a space/dash). Then we filter to exact last-10 in JS.
      const last4 = lookupPhone10.slice(-4);
      const { data, error } = await supabase
        .from('orders').select('*')
        .or(`customer_phone.ilike.%${lookupPhone10},customer_phone.ilike.%${last4}`)
        .order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      const matched = (data || []).filter(o =>
        String(o.customer_phone || '').replace(/\D/g, '').slice(-10) === lookupPhone10
      );
      // Merge, dedupe by id, sort newest-first.
      const seen = new Set(orders.map(o => o.id));
      for (const o of matched) if (!seen.has(o.id)) { orders.push(o); seen.add(o.id); }
    }
    // Sort and cap once, for every strategy. This used to live inside the phone
    // branch, so a customer with no phone on file got an unsorted list.
    orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    orders = orders.slice(0, 30);

    // Fetch return requests in parallel; replacements are already in `orders`
    // (same user) so we just scan them.
    if (orders.length) {
      const orderIds = orders.map(o => o.id);
      const { data: returns } = await supabase
        .from('return_requests').select('order_id, status').in('order_id', orderIds);
      const returnMap = {};
      (returns || []).forEach(r => { returnMap[r.order_id] = r.status; });

      // Build a map: original_order_id -> { replacement_order_id, status }
      // from any source='replacement' rows already in this user's order list.
      const replMap = {};
      for (const o of orders) {
        if (o.source !== 'replacement') continue;
        const meta = Array.isArray(o.cart_items) && o.cart_items[0]?._replacement;
        if (meta?.original_order_id) {
          replMap[meta.original_order_id] = {
            replacement_order_id: o.razorpay_order_id,
            status: o.status,
          };
        }
      }

      orders.forEach(o => {
        if (returnMap[o.id]) o.return_request_status = returnMap[o.id];
        const rm = o.razorpay_order_id && replMap[o.razorpay_order_id];
        if (rm) { o.replacement_order_id = rm.replacement_order_id; o.replacement_status = rm.status; }
      });
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
