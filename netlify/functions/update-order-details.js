/**
 * Netlify Function: update-order-details
 * POST /.netlify/functions/update-order-details
 *
 * Admin endpoint — edit a single order's customer details and/or book list.
 * Used to fix orders that were backfilled from a bare payment (e.g. a Razorpay
 * webhook save where the browser checkout never ran) and are missing the
 * customer name / address / book titles.
 *
 * Body: {
 *   id,                                  // orders.id (uuid) — preferred
 *   razorpay_order_id,                   // OR the IC-… id (fallback lookup)
 *   customer_name?, customer_phone?,
 *   customer_email?, customer_address?,  // any subset — only provided keys change
 *   books?                               // comma-separated titles → rebuilds cart_items
 * }
 *
 * Only whitelisted fields are writable. Never touches status/amount/payment ids.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { id, razorpay_order_id } = body;
  if (!id && !razorpay_order_id) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing id or razorpay_order_id' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Locate the order — by uuid id if given, else by the IC-… display id.
    const col = id ? 'id' : 'razorpay_order_id';
    const key = id || razorpay_order_id;
    const { data: order, error: fetchErr } = await supabase
      .from('orders').select('*').eq(col, key).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!order) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Order not found' }) };

    // Build the patch from only the fields that were actually provided, so a
    // blank field in the form doesn't wipe existing data.
    const patch = {};
    const strFields = ['customer_name', 'customer_phone', 'customer_email', 'customer_address'];
    for (const f of strFields) {
      if (typeof body[f] === 'string') patch[f] = body[f].trim().slice(0, 1000);
    }

    // books: rebuild cart_items from comma-separated titles. We preserve the
    // existing per-item price where a title matches; otherwise split the order
    // total evenly so the line prices still sum to the paid amount.
    if (typeof body.books === 'string' && body.books.trim()) {
      const titles = body.books.split(',').map(t => t.trim()).filter(Boolean);
      const existing = Array.isArray(order.cart_items) ? order.cart_items : [];
      const totalRs = Math.round((order.amount_paise || 0) / 100);
      const perItem = titles.length ? Math.round(totalRs / titles.length) : totalRs;
      patch.cart_items = titles.map(title => {
        const match = existing.find(i => String(i.title || '').trim().toLowerCase() === title.toLowerCase());
        return {
          title,
          qty:   match?.qty   || 1,
          price: match?.price || perItem,
          ...(match?.sku ? { sku: match.sku } : {}),
        };
      });
    }

    if (!Object.keys(patch).length) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No editable fields provided' }) };
    }

    const { error: updErr } = await supabase.from('orders').update(patch).eq('id', order.id);
    if (updErr) throw updErr;

    console.log(`[update-order-details] ${order.razorpay_order_id || order.id} updated: ${Object.keys(patch).join(', ')}`);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      success: true,
      updated: Object.keys(patch),
      order_id: order.razorpay_order_id || order.id,
    }) };
  } catch (err) {
    console.error('update-order-details error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
