/**
 * Netlify Function: admin-resend-shipped
 * POST /.netlify/functions/admin-resend-shipped
 *   { "orders": ["IC-...", ...], "dryRun": true }
 *
 * Sends the "your order has shipped" notification for orders that ALREADY
 * shipped and were never told.
 *
 * Why this exists: the XpressBees push-back notifies on the TRANSITION into
 * shipped. Orders that crossed that line before the notification existed can
 * never be picked up automatically — they have tracking in the admin panel and
 * the customer has heard nothing. This is the one-off broom for those.
 *
 * SAFETY — this messages real customers, so it is deliberately hard to misuse:
 *   - An explicit list of order numbers only. There is no "all" mode and no
 *     date range, because a query bug in an "all" mode is a mass-mail incident.
 *   - Refuses any order that is not status=shipped with a tracking_id. We must
 *     never tell someone a parcel is on its way when it isn't.
 *   - dryRun (the default) resolves and reports without sending a thing.
 *   - Fire-once via orders.shipped_notified_at, claimed with `.is(..., null)`
 *     so two concurrent calls cannot both win. If that column doesn't exist
 *     yet the send still happens but is reported as unclaimed, so a repeat run
 *     is the operator's responsibility rather than silently duplicated.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { sendShippedNotification } = require('./utils/shipped-notification');
const { buildTrackingUrl } = require('./utils/tracking-url');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

const MAX_ORDERS = 50;

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body, null, 2) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const block = requireAdmin(event, CORS);
  if (block) return block;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const wanted = (Array.isArray(body.orders) ? body.orders : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (!wanted.length) return json(400, { error: 'Pass { orders: ["IC-..."] }' });
  if (wanted.length > MAX_ORDERS) return json(400, { error: `At most ${MAX_ORDERS} orders per call` });

  // Default to a dry run: the destructive reading of an ambiguous request is
  // "send it", so the ambiguous request must not send.
  const dryRun = body.dryRun !== false;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // The fire-once column is new. Selecting a column that does not exist fails
  // the WHOLE query, so ask for it, and on that specific failure fall back to
  // the set that definitely exists rather than refusing to run at all.
  const BASE = 'id, razorpay_order_id, status, tracking_id, tracking_url, courier_name, shipped_at, customer_name, customer_phone, customer_email, cart_items';
  let haveNotifiedColumn = true;
  let { data: rows, error } = await supabase
    .from('orders')
    .select(`${BASE}, shipped_notified_at`)
    .in('razorpay_order_id', wanted);

  if (error && /shipped_notified_at/.test(error.message || '')) {
    haveNotifiedColumn = false;
    console.warn('[resend-shipped] orders.shipped_notified_at missing — run sql/orders_shipped_notified.sql for fire-once protection');
    ({ data: rows, error } = await supabase
      .from('orders')
      .select(BASE)
      .in('razorpay_order_id', wanted));
  }

  if (error) return json(500, { error: error.message });

  const byNumber = new Map((rows || []).map((r) => [String(r.razorpay_order_id), r]));
  const results = [];

  for (const orderNumber of wanted) {
    const order = byNumber.get(orderNumber);
    if (!order) { results.push({ orderNumber, action: 'skipped', reason: 'not found' }); continue; }
    if (order.status !== 'shipped') {
      results.push({ orderNumber, action: 'skipped', reason: `status is ${order.status}, not shipped` });
      continue;
    }
    if (!order.tracking_id) {
      results.push({ orderNumber, action: 'skipped', reason: 'no tracking_id' });
      continue;
    }
    if (order.shipped_notified_at) {
      results.push({ orderNumber, action: 'skipped', reason: `already notified at ${order.shipped_notified_at}` });
      continue;
    }

    const courier = order.courier_name || 'XpressBees';
    const trackingUrl = buildTrackingUrl({
      courier, awb: order.tracking_id, orderNumber, stored: order.tracking_url,
    });

    if (dryRun) {
      results.push({
        orderNumber, action: 'would send', courier, awb: order.tracking_id, trackingUrl,
        to: { phone: order.customer_phone || null, email: order.customer_email || null },
      });
      continue;
    }

    // Claim before sending. Losing the race means somebody else is sending it.
    let claimed = false;
    const claim = haveNotifiedColumn ? await supabase
      .from('orders')
      .update({ shipped_notified_at: new Date().toISOString() })
      .eq('id', order.id)
      .is('shipped_notified_at', null)
      .select('id') : { error: { message: 'column missing' }, data: null };
    if (claim.error) {
      console.warn(`[resend-shipped] cannot claim ${orderNumber} (run sql/orders_shipped_notified.sql?): ${claim.error.message}`);
    } else if (!claim.data || !claim.data.length) {
      results.push({ orderNumber, action: 'skipped', reason: 'claimed by a concurrent run' });
      continue;
    } else {
      claimed = true;
    }

    const sent = await sendShippedNotification(order, { awb: order.tracking_id, courier, trackingUrl })
      .catch((e) => ({ error: e.message }));

    // A send that failed outright should not stay marked as notified, or the
    // customer is silently written off.
    if (claimed && !(sent.whatsapp?.ok || sent.email?.ok)) {
      await supabase.from('orders').update({ shipped_notified_at: null }).eq('id', order.id);
    }

    results.push({ orderNumber, action: 'sent', courier, awb: order.tracking_id, trackingUrl, claimed, ...sent });
  }

  return json(200, {
    dryRun,
    requested: wanted.length,
    sent: results.filter((r) => r.action === 'sent').length,
    skipped: results.filter((r) => r.action === 'skipped').length,
    results,
  });
};
