/**
 * Netlify Function: review-order
 * GET /.netlify/functions/review-order?order=IC-…&t=<token>
 *
 * The minimum the review form needs to render: the buyer's first name and the
 * books on the order.
 *
 * The review page used to call track-order for this, but track-order requires
 * order id AND email/phone (it guards order data for the whole site), so with
 * only the id in the link it returned 400 every time and the page showed its
 * error screen instead of the form. Weakening track-order to fix that would
 * expose every order to anyone holding an id, so this endpoint exists instead:
 * the signed review token is the credential, and it unlocks nothing but the
 * fields below for the one order it was minted for.
 *
 * Deliberately NOT returned: address, phone, email, amounts, payment or refund
 * state. A review form has no use for any of it.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyReviewToken } = require('./utils/review-token');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const qp = event.queryStringParameters || {};
  const orderId = String(qp.order || '').trim().replace(/\s+/g, '');
  const token = String(qp.t || '').trim();

  if (!orderId || !/^[A-Za-z0-9._-]{1,80}$/.test(orderId)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid order id' }) };
  }
  if (!verifyReviewToken(orderId, token)) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'This review link is not valid — please use the link we sent you' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: order, error } = await supabase
      .from('orders')
      .select('razorpay_order_id, customer_name, cart_items, status')
      .eq('razorpay_order_id', orderId)
      .maybeSingle();
    if (error) throw error;
    if (!order) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Order not found' }) };

    if (String(order.status || '').toLowerCase() !== 'delivered') {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'You can review this once it has been delivered' }) };
    }

    // Books already reviewed on this order, so the form can leave them out
    // rather than letting the customer pick one and hit a 409 on submit.
    const { data: done } = await supabase
      .from('product_reviews')
      .select('product_slug')
      .eq('order_id', orderId);
    const reviewed = new Set((done || []).map(r => r.product_slug));

    const items = (Array.isArray(order.cart_items) ? order.cart_items : [])
      .map(i => ({
        slug: String(i?.slug || i?.id || '').replace(/^\/product\//, '').replace(/\/$/, ''),
        title: i?.title || '',
        image: i?.img || i?.image || '',
        author: i?.author || '',
      }))
      .filter(i => i.slug && !reviewed.has(i.slug));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        order_id: order.razorpay_order_id,
        first_name: String(order.customer_name || '').trim().split(' ')[0] || '',
        items,
        all_reviewed: items.length === 0,
      }),
    };
  } catch (err) {
    console.error('[review-order] error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not load this order' }) };
  }
};
