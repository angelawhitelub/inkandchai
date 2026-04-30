/**
 * Netlify Function: track-order
 * GET  /.netlify/functions/track-order?id=IC-20260430-AB3CD&q=customer-email-or-phone
 *
 * PUBLIC endpoint — anyone can call this. Returns sanitized order info
 * (status, items, courier, tracking_id, tracking_url) ONLY when:
 *   - the order_id matches AND
 *   - the supplied q (email or phone) matches what's on the order.
 *
 * This stops random people from looking up other customers' orders by
 * guessing order IDs.
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function norm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ''); }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const params = event.queryStringParameters || {};
  const id = (params.id || '').trim();
  const q  = (params.q  || '').trim();

  if (!id || !q) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide order id and email/phone' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Look up by razorpay_order_id (the public-facing one we email)
    const { data, error } = await supabase
      .from('orders')
      .select('razorpay_order_id, status, customer_name, customer_email, customer_phone, customer_address, cart_items, amount_paise, created_at, shipped_at, courier_name, tracking_id, tracking_url, razorpay_payment_id')
      .eq('razorpay_order_id', id)
      .limit(1)
      .single();

    if (error || !data) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Order not found. Check the order ID and try again.' }) };
    }

    // Verify q matches email OR phone (last 10 digits) on the order
    const qn = norm(q);
    const emailOk = data.customer_email && norm(data.customer_email) === qn;
    const phoneOk = data.customer_phone && norm(data.customer_phone).slice(-10) === qn.replace(/\D/g, '').slice(-10) && qn.replace(/\D/g, '').length >= 10;
    if (!emailOk && !phoneOk) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Email or phone does not match this order. Please use the same email/phone you used at checkout.' }) };
    }

    // Sanitize before returning — mask phone, hide unrelated fields
    const phoneMasked = data.customer_phone
      ? data.customer_phone.replace(/\D/g, '').replace(/.(?=.{4})/g, '•').replace(/(.{4})/g, '$1 ')
      : '';
    const isCOD = !data.razorpay_payment_id;
    const total = data.amount_paise ? (data.amount_paise / 100) : null;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        order: {
          order_id:        data.razorpay_order_id,
          status:          data.status,
          name:            data.customer_name,
          phone_masked:    phoneMasked,
          address:         data.customer_address,
          items:           data.cart_items || [],
          total,
          payment_method:  isCOD ? 'cod' : 'online',
          placed_at:       data.created_at,
          shipped_at:      data.shipped_at,
          courier_name:    data.courier_name,
          tracking_id:     data.tracking_id,
          tracking_url:    data.tracking_url,
        },
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
