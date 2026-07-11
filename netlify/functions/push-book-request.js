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
const { pushBotOrder } = require('./utils/push-bot-order');

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

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data: req, error: reqErr } = await supabase
      .from('bot_order_requests').select('*').eq('id', id).maybeSingle();
    if (reqErr) throw reqErr;
    if (!req) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Request not found' }) };

    const result = await pushBotOrder(supabase, req, { amountRupees, paymentMode });
    if (!result.ok) {
      return { statusCode: result.code || 400, headers: CORS, body: JSON.stringify({ error: result.error }) };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, order_id: result.order_id, status: result.status, amount: result.amount, payment_kind: result.payment_kind }),
    };
  } catch (err) {
    console.error('push-book-request error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
