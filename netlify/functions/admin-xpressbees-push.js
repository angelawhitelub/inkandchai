/**
 * Netlify Function: admin-xpressbees-push
 * POST /.netlify/functions/admin-xpressbees-push
 *   { "order_ids": ["IC-..."] }   or   { "all_unshipped": true }
 *   GET  -> what XpressBees can currently see, without changing anything
 *
 * "Push these orders to the XpressBees panel", from the admin panel.
 *
 * WHAT THIS ACTUALLY DOES, BECAUSE THE NAME PROMISES MORE THAN THE API ALLOWS
 * --------------------------------------------------------------------------
 * XpressBees has no endpoint that puts an order in the panel without also
 * generating an AWB -- not in any API version, and not in the Postman
 * collection. What it has is a Sales Channel importer that PULLS our
 * WooCommerce feed every few minutes. So nothing here pushes. What it does is
 * make an order VISIBLE in that feed, and XpressBees collects it on its next
 * pass. That is why this returns "queued" rather than "pushed": claiming a
 * push that did not happen would be a lie the operator only discovers later,
 * staring at a panel that never filled.
 *
 * Most orders need nothing done: the feed already carries every unshipped
 * order newer than WOO_FEED_SINCE, which is how 133 orders reached the panel
 * on 17 Sep without anyone pressing anything. This endpoint exists for the
 * ones OUTSIDE that window -- the older backlog -- which are invisible to
 * XpressBees no matter how long you wait. Stamping xpressbees_feed_at keeps
 * such an order in the feed regardless of age, until it ships.
 *
 * Deliberately NOT a global widening of WOO_FEED_SINCE: "only push last 3 days
 * orders" was an explicit instruction, and this has to be the exception to
 * that rule rather than a quiet repeal of it.
 *
 * Idempotent. Re-stamping an order already in the feed changes nothing, and
 * the feed itself de-duplicates by order number -- a 42-order overlap on the
 * first sync produced zero duplicates in the panel.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { classifyShipmentMoney } = require('./utils/shipment-money');
const { isReplacementOrder } = require('./utils/replacement-order');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

// Must match woo-channel's own list, or the admin panel will promise to queue
// an order the feed then refuses to carry.
const UNSHIPPED_STATUSES = [
  'paid', 'confirmed', 'cod_pending', 'partial_cod_pending', 'replacement_pending',
];
const DEFAULT_SINCE = '2026-09-15';
const isPaymentPending = (status) => /^pending(_|$)/i.test(String(status || ''));

const MAX_ORDERS = 500;
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body, null, 2) });

const feedSince = () => process.env.WOO_FEED_SINCE || DEFAULT_SINCE;

/** Every order the feed is willing to carry, before the date rule is applied. */
async function loadCandidates(supabase, orderIds) {
  let q = supabase
    .from('orders')
    .select('id, razorpay_order_id, status, created_at, customer_name, source, '
          + 'amount_paise, advance_paid_paise, razorpay_payment_id, cart_items')
    .or('source.is.null,source.neq.paperbound')
    .in('status', UNSHIPPED_STATUSES)
    .order('created_at', { ascending: true })
    .limit(MAX_ORDERS);
  if (orderIds && orderIds.length) q = q.in('razorpay_order_id', orderIds);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  // COD only, matching woo-channel's own isCollectOnDelivery. The feed refuses
  // to carry a prepaid or replacement order -- XpressBees's importer would
  // stamp it COD and bill a customer who has already paid -- so this endpoint
  // must not promise to queue one either. Book those through xpressbees-ship
  // or ithink-order-push, which state the payment mode outright.
  return (data || [])
    .filter((o) => !isPaymentPending(o.status))
    .filter((o) => {
      try { return classifyShipmentMoney(o, isReplacementOrder(o)).isCOD; }
      catch { return false; }
    });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const block = requireAdmin(event, CORS);
  if (block) return block;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const since = feedSince();

  // ---- GET: report only. Nothing is changed. ----
  if (event.httpMethod === 'GET') {
    let rows;
    try { rows = await loadCandidates(supabase, null); }
    catch (e) { return json(500, { error: e.message }); }
    const inWindow = rows.filter((o) => o.created_at >= since);
    const older    = rows.filter((o) => o.created_at < since);
    return json(200, {
      feed_since: since,
      unshipped_total: rows.length,
      visible_to_xpressbees: inWindow.length,
      older_than_window: older.length,
      oldest_excluded: older.length ? older[0].created_at : null,
      note: 'Orders inside the window are already collected automatically. Older ones need queueing.',
    });
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'GET or POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const wanted = (Array.isArray(body.order_ids) ? body.order_ids : [])
    .map((s) => String(s || '').trim()).filter(Boolean);
  const all = body.all_unshipped === true;
  if (!all && !wanted.length) return json(400, { error: 'Pass { order_ids: [...] } or { all_unshipped: true }' });
  if (wanted.length > MAX_ORDERS) return json(400, { error: `At most ${MAX_ORDERS} orders per call` });

  let rows;
  try { rows = await loadCandidates(supabase, all ? null : wanted); }
  catch (e) { return json(500, { error: e.message }); }

  const found = new Set(rows.map((o) => String(o.razorpay_order_id)));
  const results = [];

  // Anything asked for that the feed will never carry. Saying so per order
  // beats a silent count, because "why is it not in the panel" is the question
  // this endpoint exists to stop being asked.
  for (const id of wanted) {
    if (!found.has(id)) {
      results.push({
        orderNumber: id, action: 'refused',
        reason: 'not an unshipped COD order the feed will carry '
              + '(prepaid and replacement orders must be booked through xpressbees-ship or ithink-order-push)',
      });
    }
  }

  const alreadyVisible = rows.filter((o) => o.created_at >= since);
  const needStamp      = rows.filter((o) => o.created_at < since);

  for (const o of alreadyVisible) {
    results.push({
      orderNumber: o.razorpay_order_id, action: 'already queued',
      reason: 'inside the feed window; XpressBees collects it automatically',
    });
  }

  let stamped = 0;
  let migrationMissing = false;
  if (needStamp.length) {
    const { error } = await supabase
      .from('orders')
      .update({ xpressbees_feed_at: new Date().toISOString() })
      .in('id', needStamp.map((o) => o.id))
      .is('xpressbees_feed_at', null);
    if (error && /xpressbees_feed_at/.test(error.message || '')) {
      migrationMissing = true;
      for (const o of needStamp) {
        results.push({
          orderNumber: o.razorpay_order_id, action: 'blocked',
          reason: 'older than the feed window, and the queue column does not exist yet',
        });
      }
    } else if (error) {
      return json(500, { error: error.message });
    } else {
      stamped = needStamp.length;
      for (const o of needStamp) {
        results.push({
          orderNumber: o.razorpay_order_id, action: 'queued',
          reason: `older than ${since}; kept in the feed until it ships`,
        });
      }
    }
  }

  return json(200, {
    feed_since: since,
    summary: {
      queued: stamped,
      already_queued: alreadyVisible.length,
      blocked: migrationMissing ? needStamp.length : 0,
      refused: results.filter((r) => r.action === 'refused').length,
    },
    migration_needed: migrationMissing ? 'sql/orders_xpressbees_feed_at.sql' : null,
    note: 'XpressBees pulls the feed every few minutes. Nothing is pushed; these orders are now visible to it.',
    results,
  });
};
