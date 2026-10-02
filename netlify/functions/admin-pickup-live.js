/**
 * Netlify Function: admin-pickup-live
 * POST /.netlify/functions/admin-pickup-live   { order_ids: ["IC-…" | uuid, …] }   (admin)
 *
 * Asks each order's courier, live, whether the parcel has been picked up, and
 * records the answer in last_courier_status so the Not Picked Up tab stops
 * listing parcels that were delivered days ago (see utils/pickup-live.js).
 *
 * Writes only last_courier_status / last_courier_status_at, and only when a
 * courier actually answered. Never touches status, so no customer is told
 * anything; the delivered/in-transit notifications stay with the webhooks.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { checkPickups } = require('./utils/pickup-live');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX = 100;

async function loadOrders(sb, ids) {
  const uuids = ids.filter((i) => UUID.test(i));
  const refs = ids.filter((i) => !UUID.test(i));
  const cols = 'id, razorpay_order_id, status, tracking_id, courier_name, nimbus_pushed_at, ithink_pushed_at, last_nimbuspost_status, last_courier_status';
  const [a, b] = await Promise.all([
    uuids.length ? sb.from('orders').select(cols).in('id', uuids) : { data: [] },
    refs.length ? sb.from('orders').select(cols).in('razorpay_order_id', refs) : { data: [] },
  ]);
  if (a.error) throw a.error;
  if (b.error) throw b.error;
  return [...(a.data || []), ...(b.data || [])];
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS); if (block) return block;
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const ids = [...new Set((Array.isArray(body.order_ids) ? body.order_ids : []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!ids.length) return json(400, { error: 'Provide order_ids' });
  if (ids.length > MAX) return json(400, { error: `At most ${MAX} orders per call` });

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const orders = await loadOrders(sb, ids);
    const live = await checkPickups(orders);
    const now = new Date().toISOString();

    const results = [];
    for (const o of orders) {
      const r = live.get(o.id);
      if (r.state !== 'unknown' && body.record !== false && r.status !== o.last_courier_status) {
        const { error } = await sb.from('orders')
          .update({ last_courier_status: r.status.slice(0, 200), last_courier_status_at: now }).eq('id', o.id);
        if (error) console.warn('[admin-pickup-live] record', o.razorpay_order_id, error.message);
      }
      results.push({ id: o.id, order_id: o.razorpay_order_id || o.id, courier: o.courier_name || '', ...r });
    }
    const counts = results.reduce((c, r) => { c[r.state] = (c[r.state] || 0) + 1; return c; }, {});
    return json(200, { checked: results.length, counts, results });
  } catch (e) {
    console.error('[admin-pickup-live]', e);
    return json(500, { error: e.message });
  }
};
