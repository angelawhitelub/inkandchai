/**
 * Netlify Function: admin-not-picked-up
 * GET /.netlify/functions/admin-not-picked-up?min_hours=48&days=30   (admin)
 *
 * Orders placed at least `min_hours` ago (default 48) that no courier has
 * picked up: either never booked, or booked and not moved. Read-only — the
 * admin "Not Picked Up" tab. Classification lives in utils/not-picked-up.js.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { classify, summarize, UNBOOKED, DEFAULT_MIN_HOURS } = require('./utils/not-picked-up');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const COLUMNS = [
  'id', 'razorpay_order_id', 'status', 'created_at', 'customer_name', 'customer_phone', 'customer_address',
  'amount_paise', 'advance_paid_paise', 'razorpay_payment_id', 'payment_status', 'shipment_payment_type',
  'source', 'cart_items', 'tracking_id', 'tracking_url', 'courier_name', 'shipped_at', 'awb_assigned_at',
  'shipment_moved_at', 'last_courier_status', 'last_courier_status_at', 'last_nimbuspost_status',
  'nimbus_pushed_at', 'ithink_pushed_at',
];
const PAGE = 1000;

// Some of these columns arrive by migration. A missing one fails the whole
// PostgREST query, so drop it and retry instead of taking the tab down.
async function loadOrders(db, sinceIso, untilIso) {
  let cols = [...COLUMNS];
  for (let attempt = 0; attempt < 6; attempt++) {
    const rows = [];
    let failed = null;
    for (let from = 0; from < 20 * PAGE; from += PAGE) {
      const { data, error } = await db.from('orders')
        .select(cols.join(','))
        .in('status', ['shipped', ...UNBOOKED])
        .gte('created_at', sinceIso)
        .lte('created_at', untilIso)
        .order('created_at', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) { failed = error; break; }
      rows.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    if (!failed) return rows;
    const missing = String(failed.message || '').match(/column orders\.(\w+) does not exist|column "?(\w+)"? does not exist/);
    const col = missing && (missing[1] || missing[2]);
    if (!col || !cols.includes(col) || ['id', 'status', 'created_at', 'tracking_id'].includes(col)) throw new Error(failed.message);
    console.warn(`[admin-not-picked-up] orders.${col} missing — continuing without it`);
    cols = cols.filter((c) => c !== col);
  }
  throw new Error('too many missing columns');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS); if (block) return block;
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });

  const q = event.queryStringParameters || {};
  const minHours = Math.min(24 * 30, Math.max(1, Number(q.min_hours) || DEFAULT_MIN_HOURS));
  const days = Math.min(120, Math.max(3, Number(q.days) || 30));
  const now = Date.now();

  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const orders = await loadOrders(db,
      new Date(now - days * 24 * 3600 * 1000).toISOString(),
      new Date(now - minHours * 3600 * 1000).toISOString());
    const rows = orders.map((o) => classify(o, now, minHours)).filter(Boolean);
    return json(200, { generated_at: new Date(now).toISOString(), min_hours: minHours, days, counts: summarize(rows), orders: rows });
  } catch (e) {
    console.error('[admin-not-picked-up]', e.message);
    return json(500, { error: e.message });
  }
};
