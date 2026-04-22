/**
 * Netlify Function: verify-payment
 * POST /.netlify/functions/verify-payment
 * Verifies Razorpay signature and saves order to Supabase.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    cart,
    customer,
    amount,
  } = body;

  // ── 1. Verify signature ───────────────────────────────────────────────────
  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSig !== razorpay_signature) {
    console.error('Signature mismatch');
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid signature' }) };
  }

  // ── 2. Save to Supabase ───────────────────────────────────────────────────
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY   // service role key (server-side only)
    );

    const { error } = await supabase.from('orders').insert({
      razorpay_order_id,
      razorpay_payment_id,
      amount_paise:     amount,
      status:           'paid',
      customer_name:    customer?.name    || '',
      customer_email:   customer?.email   || '',
      customer_phone:   customer?.phone   || '',
      customer_address: customer?.address || '',
      cart_items:       cart,             // stored as JSONB
    });

    if (error) throw error;

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, payment_id: razorpay_payment_id }),
    };

  } catch (err) {
    console.error('Supabase save error:', err);
    // Payment was valid even if DB save fails — don't return error to customer
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, warning: 'Order not saved to DB', payment_id: razorpay_payment_id }),
    };
  }
};
