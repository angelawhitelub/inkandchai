/**
 * Scheduled function: busy-ship-scheduled   (every 15 min, jobs.toml)
 *
 * Counts units per book over placed, not-cancelled orders from the last 24
 * hours and publishes the books above 50 (utils/busy-ship) so their product
 * pages show the Ships-by date one day later. Read-only on orders; writes only
 * the KV list. Admin may POST to refresh now.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { busyFromOrders, publishBusy, SOLD_STATUSES, WINDOW_MS, THRESHOLD } = require('./utils/busy-ship');

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function handle(event = {}, deps = {}) {
  if (event.rawUrl && !deps.skipAuth) {
    const blocked = requireAdmin(event, { 'Content-Type': 'application/json' });
    if (blocked) return blocked;
  }
  try {
    const db = deps.db || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const now = deps.now || Date.now();
    const since = new Date(now - WINDOW_MS).toISOString();
    const orders = [];
    for (let from = 0; from < 50000; from += 1000) {
      const { data, error } = await db.from('orders')
        .select('razorpay_order_id,source,cart_items,created_at')
        .in('status', SOLD_STATUSES)
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(`orders: ${error.message}`);
      orders.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const slugs = busyFromOrders(orders);
    await (deps.publish || publishBusy)(slugs, now);
    console.log(`[busy-ship] ${orders.length} orders in 24 h, ${Object.keys(slugs).length} books above ${THRESHOLD}: ${JSON.stringify(slugs)}`);
    return json(200, { ok: true, orders: orders.length, threshold: THRESHOLD, busy: slugs });
  } catch (e) {
    console.error('[busy-ship]', e.message);
    return json(500, { error: e.message });
  }
}

exports.handler = (event) => handle(event);
exports._test = { handle };
