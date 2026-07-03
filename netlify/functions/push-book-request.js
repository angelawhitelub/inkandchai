/**
 * Netlify Function: push-book-request
 * POST /.netlify/functions/push-book-request
 *
 * Admin endpoint — converts a WhatsApp bot book-order request
 * (bot_order_requests) into a REAL order in the orders table, so it flows
 * through the normal pipeline: appears in the Orders tab, can be pushed to
 * NimbusPost, gets an AWB via the AWB sync, and the customer is auto-notified
 * on WhatsApp when it ships.
 *
 * Body: { id: <bot_order_requests.id>, amount_rupees: <number>, payment_mode: 'cod'|'prepaid' }
 *
 * Reuses the request's IC-W- order id (or mints one) as razorpay_order_id.
 * Headers: X-Admin-Token / X-Admin-Key.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { pushOrderToNimbusPost } = require('./utils/nimbuspost-import');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-Admin-Key',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase env vars missing' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const id = String(body.id || '').trim();
  const amountRupees = Math.round(Number(body.amount_rupees) || 0);
  const paymentMode = body.payment_mode === 'prepaid' ? 'prepaid' : 'cod';
  if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide request id' }) };
  if (!amountRupees || amountRupees <= 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide a valid amount (rupees).' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data: req, error: reqErr } = await supabase
      .from('bot_order_requests').select('*').eq('id', id).maybeSingle();
    if (reqErr) throw reqErr;
    if (!req) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Request not found' }) };
    if (req.order_pushed_id) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Already pushed as ${req.order_pushed_id}.` }) };
    }

    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randPart = Math.random().toString(36).slice(2, 7).toUpperCase();
    const orderId = req.order_id || `IC-W-${datePart}-${randPart}`;

    const phone10 = String(req.customer_phone || '').replace(/\D/g, '').slice(-10);
    const amountPaise = amountRupees * 100;
    // Single line item — the book name(s) the customer gave. Admin can refine
    // later; price carries the amount so labels/invoices render sensibly.
    const cart = [{ title: req.books || 'Book', qty: 1, price: amountRupees }];
    // COD → cod_pending (ships on normal flow). Prepaid → confirmed (team will
    // collect payment via link/UPI out of band before shipping).
    const status = paymentMode === 'cod' ? 'cod_pending' : 'confirmed';

    const { error: insErr } = await supabase.from('orders').insert({
      razorpay_order_id:   orderId,
      razorpay_payment_id: null,
      amount_paise:        amountPaise,
      status,
      customer_name:       req.customer_name || '',
      customer_email:      '',
      customer_phone:      phone10,
      customer_address:    req.address || '',
      cart_items:          cart,
    });
    if (insErr) {
      // Unique violation → order id already exists; surface it.
      if (insErr.code === '23505') {
        return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: `Order ${orderId} already exists.` }) };
      }
      throw insErr;
    }

    // Mark the request as converted so it can't be double-pushed.
    await supabase.from('bot_order_requests')
      .update({ status: 'ordered', order_pushed_id: orderId })
      .eq('id', id);

    // Push to NimbusPost so it can be shipped (AWB sync then notifies customer).
    pushOrderToNimbusPost({
      razorpay_order_id: orderId,
      status,
      customer_name: req.customer_name || '',
      customer_phone: phone10,
      customer_address: req.address || '',
      amount_paise: amountPaise,
      cart_items: cart,
    }).catch(e => console.error('[NimbusPost] push-book-request failed (non-fatal):', e.message));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, order_id: orderId, status, amount: amountRupees }),
    };
  } catch (err) {
    console.error('push-book-request error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
