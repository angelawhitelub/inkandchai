/**
 * Netlify Function: admin-order-items   (admin, read-only)
 * GET /.netlify/functions/admin-order-items?ids=IC-...,IC-...
 *
 * The books on each order, from our own record: { orders: { "IC-...": [ { title, qty, price, slug } ] } }.
 * No customer details. Used by the local packing scripts
 * (Python/update_orders_and_catalog.py): the XpressBees shipment export has
 * only ten Product columns, so an order with more books loses the rest there
 * (IC-CW-20261110-WD9K5: 17 books, 10 in the CSV, 12 Nov 2026).
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const MAX_IDS = 200;

/** Book lines of an order: skips payment markers, merges nothing, keeps the order's own sequence. */
function booksOf(order) {
  let items = order && order.cart_items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
  if (!Array.isArray(items)) return [];
  return items
    .filter((i) => i && typeof i === 'object' && !i._payment && !i.__payment && String(i.title || i.name || '').trim())
    .map((i) => {
      const m = /\/product\/([^/?#]+)/i.exec(String(i.url || i.id || ''));
      return {
        title: String(i.title || i.name).trim(),
        qty: Math.max(1, parseInt(i.qty ?? i.quantity ?? 1, 10) || 1),
        price: Number(i.price) || null,
        slug: String(i.slug || (m ? m[1] : '') || '').toLowerCase() || null,
      };
    });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });
  const ids = [...new Set(String((event.queryStringParameters || {}).ids || '')
    .split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9-]{4,60}$/.test(s)))];
  if (!ids.length) return json(400, { error: 'Pass ?ids=IC-...,IC-...' });
  if (ids.length > MAX_IDS) return json(400, { error: `At most ${MAX_IDS} orders per call` });
  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data, error } = await db.from('orders').select('razorpay_order_id, cart_items').in('razorpay_order_id', ids);
    if (error) throw error;
    const orders = {};
    for (const o of data || []) orders[String(o.razorpay_order_id).toUpperCase()] = booksOf(o);
    return json(200, { orders, missing: ids.filter((id) => !orders[id]) });
  } catch (e) {
    console.error('[admin-order-items]', e.message);
    return json(500, { error: e.message });
  }
};

exports.booksOf = booksOf;
