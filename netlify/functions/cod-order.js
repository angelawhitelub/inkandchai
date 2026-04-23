/**
 * Netlify Function: cod-order
 * POST /.netlify/functions/cod-order
 * Saves a Cash on Delivery order to Supabase.
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { cart, customer, amount } = body;

  if (!cart?.length || !customer?.phone) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing cart or phone number' }) };
  }

  const orderId = `COD-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { error } = await supabase.from('orders').insert({
      razorpay_order_id:   orderId,
      razorpay_payment_id: null,
      amount_paise:        Math.round(amount * 100),
      status:              'cod_pending',
      customer_name:       customer.name    || '',
      customer_email:      customer.email   || '',
      customer_phone:      customer.phone,
      customer_address:    customer.address || '',
      cart_items:          cart,
    });

    if (error) throw error;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, order_id: orderId }),
    };

  } catch (err) {
    console.error('COD order error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Could not save order', details: err.message }),
    };
  }
};
