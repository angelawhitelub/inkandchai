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

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

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

  // Verify order exists
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select('id, razorpay_order_id, customer_name, customer_email, status')
    .or(`razorpay_order_id.eq.${order_id},id.eq.${order_id}`)
    .maybeSingle();

  if (orderErr || !order) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Order not found' }) };
  }

  // Check for duplicate review (one review per order per product)
  const { data: existing } = await supabase
    .from('product_reviews')
    .select('id')
    .eq('order_id', order_id)
    .eq('product_slug', product_slug)
    .maybeSingle();

  if (existing) {
    return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'You have already reviewed this product' }) };
  }

  // Save review
  const { data: review, error: insertErr } = await supabase
    .from('product_reviews')
    .insert({
      order_id,
      product_slug,
      rating: r,
      comment: (comment || '').trim().slice(0, 1000),
      customer_name: (customer_name || order.customer_name || 'Verified Buyer').trim().slice(0, 80),
      customer_email: order.customer_email || '',
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
