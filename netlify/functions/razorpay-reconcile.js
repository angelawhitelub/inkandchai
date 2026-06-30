/**
 * Netlify Function: razorpay-reconcile
 * POST /.netlify/functions/razorpay-reconcile
 *
 * Admin endpoint: checks a Razorpay payment ID against Razorpay API.
 * If payment is captured but no order exists in Supabase, creates the order.
 *
 * Body: { razorpay_payment_id: "pay_XXXXX" }
 *    OR { razorpay_order_id: "order_XXXXX" }
 * Headers: Authorization: Bearer <admin_password>
 */

const { createClient } = require('@supabase/supabase-js');
const { sendWhatsApp } = require('./utils/whatsapp');
const { makeOrderId } = require('./utils/pricing');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function verifyAdmin(event) {
  const auth = (event.headers['authorization'] || event.headers['Authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  return auth === process.env.ADMIN_PASSWORD;
}

async function razorpayFetch(path) {
  const key    = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key || !secret) throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set');
  const auth = Buffer.from(`${key}:${secret}`).toString('base64');
  const res  = await fetch(`https://api.razorpay.com/v1${path}`, {
    headers: { 'Authorization': `Basic ${auth}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Razorpay API error: ${JSON.stringify(data)}`);
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  if (!verifyAdmin(event)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };

  const body = JSON.parse(event.body || '{}');
  const { razorpay_payment_id, razorpay_order_id } = body;

  if (!razorpay_payment_id && !razorpay_order_id) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide razorpay_payment_id or razorpay_order_id' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    let payment = null;

    // Fetch payment from Razorpay
    if (razorpay_payment_id) {
      payment = await razorpayFetch(`/payments/${razorpay_payment_id}`);
    } else {
      // Fetch by order_id — get the payments for this order
      const result = await razorpayFetch(`/orders/${razorpay_order_id}/payments`);
      const items = result.items || [];
      // Find a captured payment
      payment = items.find(p => p.status === 'captured') || items[0];
    }

    if (!payment) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'No payment found in Razorpay' }) };
    }

    const pay_id   = payment.id;
    const ord_id   = payment.order_id;
    const status   = payment.status;   // authorized | captured | failed | refunded
    const amount   = payment.amount;   // paise

    // Check if already in our DB
    const { data: existing } = await supabase
      .from('orders')
      .select('id, razorpay_order_id, status')
      .eq('razorpay_payment_id', pay_id)
      .maybeSingle();

    if (existing) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        ok: true,
        already_exists: true,
        our_order_id: existing.razorpay_order_id,
        our_status:   existing.status,
        razorpay_status: status,
        message: `Order already in system as ${existing.razorpay_order_id} (${existing.status})`,
      }) };
    }

    if (status !== 'captured') {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        ok: false,
        razorpay_status: status,
        message: `Payment status is "${status}" — not captured. Cannot confirm order. Customer will get auto-refund from Razorpay.`,
      }) };
    }

    // Payment is captured but no order exists — create it
    const name    = payment.notes?.name    || '';
    const email   = payment.email          || '';
    const phone   = payment.contact        || '';
    const address = payment.notes?.shipping_address || '';

    // Try to get cart from abandoned_checkouts
    const { data: abandoned } = await supabase
      .from('abandoned_checkouts')
      .select('*')
      .eq('razorpay_order_id', ord_id)
      .maybeSingle();
    const cart     = abandoned?.cart_items || [];
    const customer = abandoned?.customer   || {};

    // IC- (or IC-CW- for Crossword-migrated genuine-tag carts) order ID.
    const inkOrderId = await makeOrderId('IC', cart, supabase);

    const { error: saveErr } = await supabase.from('orders').insert({
      razorpay_order_id:   inkOrderId,
      razorpay_payment_id: pay_id,
      amount_paise:        amount,
      status:              'paid',
      customer_name:       customer.name    || name,
      customer_email:      customer.email   || email,
      customer_phone:      customer.phone   || phone,
      customer_address:    customer.address || address,
      cart_items:          cart,
    });

    if (saveErr) throw new Error(saveErr.message);

    console.log(`[razorpay-reconcile] ✅ Saved missed order: ${inkOrderId} (${pay_id})`);

    // WhatsApp customer
    const finalPhone = customer.phone || phone;
    if (finalPhone) {
      const firstName = (customer.name || name || 'there').split(' ')[0];
      const amtDisplay = `₹${(amount / 100).toLocaleString('en-IN')}`;
      await sendWhatsApp({
        to: finalPhone,
        template: 'order_confirmed',
        params: [
          firstName,
          inkOrderId,
          amtDisplay,
          (customer.address || address || '').slice(0, 80),
          cart.map(i => i.title || '').filter(Boolean).join(', ').slice(0, 200) || 'your books',
        ],
      }).catch(e => console.warn('WA notify error:', e.message));
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: true,
      created: true,
      our_order_id:    inkOrderId,
      razorpay_status: status,
      amount_paise:    amount,
      customer_phone:  finalPhone || '—',
      message: `✅ Order created: ${inkOrderId}. WhatsApp sent to customer.`,
    }) };

  } catch (err) {
    console.error('[razorpay-reconcile] error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
