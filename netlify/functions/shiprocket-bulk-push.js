/**
 * Netlify Function: shiprocket-bulk-push
 * POST /.netlify/functions/shiprocket-bulk-push
 *
 * Admin endpoint: push a batch of unshipped orders to Shiprocket.
 * Called by the "🚀 Push All to Shiprocket" button in the admin panel.
 *
 * Body: { order_ids: ["IC-...", "IC-...", ...] }
 * OR:   { all_unshipped: true }   ← fetches all from Supabase automatically
 *       { dry_run: true }         ← classify and total everything, send nothing
 * Headers: X-Admin-Key / X-Admin-Token
 */

const { createClient } = require('@supabase/supabase-js');
const { pushOrderToShiprocket } = require('./utils/shiprocket');
const { classifyShipmentMoney } = require('./utils/shipment-money');
const { isReplacementOrder } = require('./utils/replacement-order');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

// pending_phonepe and pending_partial_phonepe are deliberately ABSENT. They
// were in this list, and they mean PhonePe has not confirmed the payment yet.
// Because the old COD test keyed off the status name, neither matched, so both
// would have gone out as 'Prepaid' -- a courier told to collect nothing, for an
// order nobody has paid for. The same list in ithink-order-push.js has never
// included them, and woo-channel.js screens them out by pattern.
const UNSHIPPED_STATUSES = [
  'paid', 'confirmed', 'cod_pending', 'partial_cod_pending',
  'replacement_pending',
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
      // paperbound is a separate storefront with its own fulfilment; never push
      // it. Both the iThink and XpressBees paths carry the same exclusion.
      .or('source.is.null,source.neq.paperbound')
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

  // Dry run: classify every order with the same function the real push uses and
  // report what the courier would be told to collect, without contacting
  // Shiprocket at all. This is the read-back the integration never had. On 17
  // September 133 orders booked with the wrong payment mode and stayed wrong
  // for two days precisely because nothing compared the two sides first.
  if (body.dry_run) {
    const preview = { queued: 0, cod_orders: 0, cod_collectable: 0,
                      prepaid_orders: 0, prepaid_declared: 0 };
    const rows = [], refused = [];
    for (const order of orders) {
      const id = order.razorpay_order_id || order.id;
      if (order.tracking_id) { refused.push({ order_id: id, reason: `already has AWB ${order.tracking_id}` }); continue; }
      if (order.shiprocket_order_id) { refused.push({ order_id: id, reason: `already in Shiprocket as ${order.shiprocket_order_id}` }); continue; }
      let money;
      try { money = classifyShipmentMoney(order, isReplacementOrder(order)); }
      catch (e) { refused.push({ order_id: id, reason: String(e.message || e) }); continue; }
      preview.queued++;
      if (money.isCOD) { preview.cod_orders++; preview.cod_collectable += money.collectableAmount; }
      else { preview.prepaid_orders++; preview.prepaid_declared += money.orderValueRs; }
      rows.push({ order_id: id, status: order.status, mode: money.shipmentPaymentType,
                  collect: money.collectableAmount, declared: money.orderValueRs });
    }
    return { statusCode: 200, headers: CORS,
             body: JSON.stringify({ dry_run: true, pickup_location: process.env.SHIPROCKET_PICKUP_LOCATION || 'Office',
                                    totals: preview, orders: rows, refused }, null, 2) };
  }

  for (const order of orders) {
    // An order that already carries an AWB has been booked with some courier.
    // Pushing it again creates a second parcel for one sale.
    if (order.tracking_id) {
      summary.skipped++;
      continue;
    }
    // A Shiprocket id without an AWB is an order already sitting in the panel
    // awaiting a courier. The AWB guard above cannot see it, so without this a
    // re-run books the same sale twice — one of them uncollectable.
    if (order.shiprocket_order_id) {
      summary.skipped++;
      continue;
    }
    try {
      await pushOrderToShiprocket(order);
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
