/**
 * Netlify Function: admin-pincode-serviceability
 * GET  /.netlify/functions/admin-pincode-serviceability?pin=411030
 * POST /.netlify/functions/admin-pincode-serviceability
 *      { pins: ["411030", ...] }                 -> verdict per pincode
 *      { all_unshipped: true }                   -> tag every unshipped order
 *      { order_ids: ["IC-..."] }                 -> tag these orders
 * Headers: X-Admin-Key / X-Admin-Token
 *
 * Answers "will Delhivery carry this?" from their published serviceability
 * export instead of from a failed booking. Read-only: it books nothing,
 * cancels nothing and writes nothing.
 *
 * An order whose pincode is absent from the export is tagged
 * `unshippable_by_delhivery` -- it needs another courier, and no amount of
 * retrying Delhivery will move it.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { classifyShipmentMoney } = require('./utils/shipment-money');
const { isReplacementOrder } = require('./utils/replacement-order');
const { parseAddress } = require('./utils/np-normalize');
const dp = require('./utils/delhivery-pincodes');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body, null, 2) });

const UNSHIPPED = ['paid', 'confirmed', 'cod_pending', 'partial_cod_pending', 'replacement_pending'];

/** The pincode we would actually ship to, read the same way the couriers read it. */
function orderPin(order) {
  const addr = parseAddress(order.customer_address || '');
  return dp.normalizePin(addr.pincode || addr.pin || order.customer_pincode || '');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS);
  if (block) return block;

  const meta = { source: 'Delhivery serviceability export', pincodes: dp.count, generated_at: dp.generatedAt };

  if (event.httpMethod === 'GET') {
    const pin = event.queryStringParameters?.pin;
    if (!pin) return json(400, { error: 'pass ?pin=411030', ...meta });
    return json(200, { ...meta, ...dp.classify(pin) });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'GET or POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  if (Array.isArray(body.pins) && body.pins.length) {
    return json(200, { ...meta, results: body.pins.slice(0, 500).map((p) => dp.classify(p)) });
  }

  const ids = Array.isArray(body.order_ids) ? body.order_ids.map((s) => String(s).trim()) : [];
  if (!ids.length && !body.all_unshipped) {
    return json(400, { error: 'pass pins: [...], order_ids: [...] or all_unshipped: true', ...meta });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let q = supabase.from('orders')
    .select('razorpay_order_id, id, status, customer_name, customer_address, cart_items, amount_paise, tracking_id, courier_name, created_at')
    .or('source.is.null,source.neq.paperbound')
    .order('created_at', { ascending: false })
    .limit(500);
  if (ids.length) q = q.in('razorpay_order_id', ids);
  else q = q.in('status', UNSHIPPED).is('tracking_id', null);

  const { data, error } = await q;
  if (error) return json(500, { error: error.message });

  const shippable = [], unshippable = [], unreadable = [];
  for (const o of data || []) {
    const id = o.razorpay_order_id || o.id;
    const pin = orderPin(o);
    let isCOD = false;
    try { isCOD = classifyShipmentMoney(o, isReplacementOrder(o)).isCOD; } catch { isCOD = false; }
    const v = dp.canShip(pin, { isCOD });
    const row = { order_id: id, status: o.status, customer: o.customer_name,
                  pin: pin || null, cod: isCOD, reason: v.reason || undefined };
    if (!pin) unreadable.push(row);
    else if (v.ok) shippable.push(row);
    else unshippable.push({ ...row, unshippable_by_delhivery: true });
  }

  return json(200, {
    ...meta,
    checked: (data || []).length,
    shippable_by_delhivery: shippable.length,
    unshippable_by_delhivery: unshippable.length,
    pincode_unreadable: unreadable.length,
    unshippable,
    unreadable,
  });
};
