/**
 * Netlify Function: razorpay-check-order
 * POST /.netlify/functions/razorpay-check-order
 *
 * Called by checkout page polling loop when payment is "processing".
 * Checks Razorpay API for the order's payment status.
 *
 * Body: { razorpay_order_id: "order_XXXXX" }
 * Returns:
 *   { payment_captured: true,  razorpay_payment_id: "pay_XXX", razorpay_signature: "..." }
 *   { payment_captured: false, payment_failed: false }   — still processing
 *   { payment_captured: false, payment_failed: true }    — definitively failed
 */

const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const { razorpay_order_id } = JSON.parse(event.body || '{}');
  if (!razorpay_order_id) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'razorpay_order_id required' }) };
  }

  const key    = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key || !secret) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Razorpay keys not configured' }) };
  }

  try {
    const auth = Buffer.from(`${key}:${secret}`).toString('base64');
    const res  = await fetch(`https://api.razorpay.com/v1/orders/${razorpay_order_id}/payments`, {
      headers: { 'Authorization': `Basic ${auth}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));

    const payments = data.items || [];
    const captured = payments.find(p => p.status === 'captured');
    const failed   = payments.every(p => p.status === 'failed') && payments.length > 0;

    if (captured) {
      // Generate a server-side signature so verify-payment can skip client signature check
      const signature = crypto
        .createHmac('sha256', secret)
        .update(`${razorpay_order_id}|${captured.id}`)
        .digest('hex');

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          payment_captured:    true,
          payment_failed:      false,
          razorpay_payment_id: captured.id,
          razorpay_signature:  signature,
          amount:              captured.amount,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        payment_captured: false,
        payment_failed:   failed,
        payments_count:   payments.length,
        statuses:         payments.map(p => p.status),
      }),
    };

  } catch (err) {
    console.error('[razorpay-check-order] error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
