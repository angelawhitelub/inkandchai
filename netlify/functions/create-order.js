/**
 * Netlify Function: create-order
 * POST /.netlify/functions/create-order
 * Creates a Razorpay order and returns { id, amount, currency }
 */

const Razorpay = require('razorpay');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { amount, currency = 'INR', receipt, notes } = body;

  if (!amount || amount < 100) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid amount' }) };
  }

  try {
    const razorpay = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const order = await razorpay.orders.create({
      amount:   Math.round(amount),   // paise
      currency,
      receipt:  receipt || `inkandchai_${Date.now()}`,
      notes:    notes || {},
    });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        id:       order.id,
        amount:   order.amount,
        currency: order.currency,
      }),
    };

  } catch (err) {
    console.error('Razorpay order error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Failed to create order', details: err.message }),
    };
  }
};
