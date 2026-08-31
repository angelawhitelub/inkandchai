/**
 * Netlify Function: submit-review
 * POST /.netlify/functions/submit-review
 *
 * Validates order ownership, saves review to product_reviews table.
 * Review starts as approved=false (pending admin approval).
 *
 * Body: { order_id, product_slug, rating (1-5), comment, customer_name }
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyReviewToken } = require('./utils/review-token');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function last10(p) { return String(p || '').replace(/\D/g, '').slice(-10); }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Prove the caller was actually sent here ──────────────────────────────
  // Two accepted proofs. A signed-in customer's JWT (checked against the order
  // below), or the HMAC token we minted into the review link we messaged them.
  // Requiring the JWT alone is what kept this table empty: /review/ has no
  // sign-in, so every real submission 401'd. Accepting neither would put back
  // the original hole, where a leaked order id bought you a 5★ "Verified
  // Buyer" review on any product.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  let user = null;
  if (jwt) {
    try {
      const { data, error } = await supabase.auth.getUser(jwt);
      if (error || !data?.user) throw error || new Error('no_user');
      user = data.user;
    } catch {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid session — please sign in again' }) };
    }
  }
  const userEmail = (user?.email || '').toLowerCase();
  const userPhone10 = last10(user?.user_metadata?.phone || user?.phone || '');

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { order_id, product_slug, rating, comment, customer_name } = body || {};

  // Validate required fields
  if (!order_id || !product_slug || !rating) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'order_id, product_slug and rating are required' }) };
  }
  const r = parseInt(rating);
  if (r < 1 || r > 5) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Rating must be 1–5' }) };
  }

  // Look up the order. order_id can be either the IC-XXXXX display ID
  // (razorpay_order_id column) or the row UUID — try them as two separate,
  // sanitised exact queries instead of building a PostgREST .or() filter
  // string from raw user input (which is filter-syntax-injectable).
  const cleanId = String(order_id).trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(cleanId)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid order_id' }) };
  }
  let order = null;
  {
    const { data } = await supabase
      .from('orders')
      .select('id, razorpay_order_id, customer_name, customer_email, customer_phone, status')
      .eq('razorpay_order_id', cleanId)
      .maybeSingle();
    order = data || null;
  }
  if (!order && /^[0-9a-f-]{36}$/i.test(cleanId)) {
    const { data } = await supabase
      .from('orders')
      .select('id, razorpay_order_id, customer_name, customer_email, customer_phone, status')
      .eq('id', cleanId)
      .maybeSingle();
    order = data || null;
  }
  if (!order) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Order not found' }) };
  }

  // Ownership: either the signed-in user matches the order's email/phone, or
  // the request carries the link token we signed for this exact order id.
  const orderEmail = (order.customer_email || '').toLowerCase();
  const orderPhone10 = last10(order.customer_phone);
  const ownsByEmail = userEmail && orderEmail && userEmail === orderEmail;
  const ownsByPhone = userPhone10 && orderPhone10 && userPhone10 === orderPhone10;
  const ownsByToken = verifyReviewToken(order.razorpay_order_id || cleanId, (body || {}).t);
  if (!ownsByEmail && !ownsByPhone && !ownsByToken) {
    return {
      statusCode: user ? 403 : 401,
      headers: CORS,
      body: JSON.stringify({ error: user ? 'This order is not yours' : 'This review link is not valid — please use the link we sent you' }),
    };
  }

  // Only a delivered order can be reviewed. Without this a token holder could
  // review something still in transit (or cancelled), which is exactly the
  // "verified buyer" claim the badge is making.
  if (String(order.status || '').toLowerCase() !== 'delivered') {
    return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'You can review this once it has been delivered' }) };
  }

  // Check for duplicate review (one review per order per product)
  const { data: existing } = await supabase
    .from('product_reviews')
    .select('id')
    .eq('order_id', cleanId)
    .eq('product_slug', product_slug)
    .maybeSingle();

  if (existing) {
    return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'You have already reviewed this product' }) };
  }

  // Save review. customer_name is taken from the order (not the request body)
  // so attackers can't impersonate the buyer.
  const { data: review, error: insertErr } = await supabase
    .from('product_reviews')
    .insert({
      order_id: cleanId,
      product_slug,
      rating: r,
      comment: (comment || '').trim().slice(0, 1000),
      customer_name: (order.customer_name || 'Verified Buyer').trim().slice(0, 80),
      customer_email: orderEmail,
      approved: false,
      verified_buyer: true,
    })
    .select()
    .single();

  if (insertErr) {
    console.error('submit-review insert error:', insertErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Failed to save review' }) };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ success: true, review_id: review.id }),
  };
};
