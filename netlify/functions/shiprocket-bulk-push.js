/**
 * Netlify Function: shiprocket-bulk-push
 * POST /.netlify/functions/shiprocket-bulk-push
 *
 * Admin endpoint: push a batch of unshipped orders to Shiprocket.
 * Called by the "🚀 Push All to Shiprocket" button in the admin panel.
 *
 * Body: { order_ids: ["IC-...", "IC-...", ...] }
 * OR:   { all_unshipped: true }   ← fetches all from Supabase automatically
 * Headers: X-Admin-Key: <admin_password>
 */

const { createClient } = require('@supabase/supabase-js');
const { pushOrderToShiprocket } = require('./utils/shiprocket');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

const UNSHIPPED_STATUSES = [
  'paid', 'confirmed', 'cod_pending', 'partial_cod_pending',
  'pending_phonepe', 'pending_partial_phonepe',
];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;

  const body = JSON.parse(event.body || '{}');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Fetch orders to push
  let orders = [];

  if (body.all_unshipped) {
    // Fetch ALL unshipped orders from Supabase
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .in('status', UNSHIPPED_STATUSES)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    orders = data || [];
  } else if (Array.isArray(body.order_ids) && body.order_ids.length > 0) {
    // Fetch specific orders by IC- order ID
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .in('razorpay_order_id', body.order_ids);
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    orders = data || [];
  } else {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide order_ids array or all_unshipped:true' }) };
  }

  if (!orders.length) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ summary: { pushed: 0, skipped: 0, failed: 0 }, message: 'No orders to push' }) };
  }

  console.log(`[shiprocket-bulk-push] Pushing ${orders.length} orders to Shiprocket…`);

  // Get a single Shiprocket token upfront (avoid re-authenticating for every order)
  // We do this by pushing the first order which internally caches nothing,
  // but we batch with a small delay to avoid rate limiting
  const summary = { pushed: 0, skipped: 0, failed: 0, errors: [] };

  for (const order of orders) {
    try {
      await pushOrderToShiprocket({
        inkOrderId:      order.razorpay_order_id || order.id,
        customerName:    order.customer_name    || '',
        customerEmail:   order.customer_email   || '',
        customerPhone:   order.customer_phone   || '',
        customerAddress: order.customer_address || '',
        cartItems:       order.cart_items,
        amountPaise:     order.amount_paise,
        status:          order.status,
        createdAt:       order.created_at,
      });
      summary.pushed++;
    } catch (err) {
      const msg = err.message || '';
      // Shiprocket returns error if order already exists — treat as skipped
      if (msg.includes('already') || msg.includes('duplicate') || msg.includes('exists')) {
        summary.skipped++;
        console.log(`[shiprocket-bulk-push] Order ${order.razorpay_order_id} already in Shiprocket — skipped`);
      } else {
        summary.failed++;
        summary.errors.push(`${order.razorpay_order_id}: ${msg.slice(0, 100)}`);
        console.error(`[shiprocket-bulk-push] Failed ${order.razorpay_order_id}:`, msg);
      }
    }

    // Small delay between orders to avoid Shiprocket rate limits
    if (orders.length > 5) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log(`[shiprocket-bulk-push] Done. pushed=${summary.pushed} skipped=${summary.skipped} failed=${summary.failed}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      summary,
      message: `Pushed ${summary.pushed} orders to Shiprocket. ${summary.skipped} already existed. ${summary.failed} failed.`,
      ...(summary.errors.length ? { errors: summary.errors } : {}),
    }),
  };
};
