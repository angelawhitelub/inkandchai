/**
 * Netlify Function: save-abandoned-checkout
 * POST /.netlify/functions/save-abandoned-checkout
 *
 * Captures checkout details before an order is completed so the admin can
 * follow up with customers who typed contact details and left.
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function clean(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, skipped: 'Supabase not configured' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const sessionId = clean(body.session_id, 120);
  const cart = Array.isArray(body.cart) ? body.cart.slice(0, 50) : [];
  const customer = body.customer || {};
  const name = clean(customer.name, 160);
  const email = clean(customer.email, 240).toLowerCase();
  const phone = clean(customer.phone, 40);
  const address = clean(customer.address, 1000);
  const status = body.status === 'converted' ? 'converted' : 'open';

  if (!sessionId || !cart.length || (!email && !phone && !name)) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, skipped: 'Not enough checkout detail yet' }) };
  }

  const subtotal = cart.reduce((sum, item) => {
    const price = Number(item.price) || 0;
    const qty = Number(item.qty) || 0;
    return sum + price * qty;
  }, 0);
  const shipping = Number(body.shipping || 0);
  const amountPaise = Math.round((subtotal + shipping) * 100);

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const now = new Date().toISOString();
    const payload = {
      session_id: sessionId,
      customer_name: name,
      customer_email: email,
      customer_phone: phone,
      customer_address: address,
      cart_items: cart,
      amount_paise: amountPaise,
      status,
      last_seen_at: now,
      updated_at: now,
      converted_order_id: clean(body.order_id, 160) || null,
      converted_at: status === 'converted' ? now : null,
    };

    const { data, error } = await supabase
      .from('abandoned_checkouts')
      .upsert(payload, { onConflict: 'session_id' })
      .select('id,status')
      .single();

    if (error) throw error;
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, checkout: data }) };
  } catch (err) {
    console.error('save-abandoned-checkout error:', err.message);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
