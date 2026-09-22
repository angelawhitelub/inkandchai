/**
 * Netlify Function: shiprocket-cancel
 * POST /.netlify/functions/shiprocket-cancel
 *
 * Admin endpoint: cancel orders sitting in the Shiprocket panel.
 *
 * Body: { order_ids: ["IC-...", ...] }   ← OUR order ids, not Shiprocket's
 *       { dry_run: true }                ← resolve and report, cancel nothing
 * Headers: X-Admin-Key / X-Admin-Token
 *
 * Takes our IC- ids rather than raw Shiprocket ids on purpose. A raw id is
 * eight digits with no check on it, and the thing it cancels is a real parcel;
 * resolving through the database means a typo finds no order instead of
 * cancelling somebody else's shipment.
 *
 * An order that already carries an AWB is refused. Once a courier has the
 * parcel, cancelling the order in the panel does not stop the delivery — that
 * is a return, and it has to be raised as one.
 *
 * On success shiprocket_order_id is deliberately LEFT IN PLACE. It is what
 * shiprocket-bulk-push checks to avoid re-booking, and the usual reason to
 * cancel is a duplicate we never want pushed again. Clearing it would hand the
 * order straight back to the next bulk push.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const BASE = 'https://apiv2.shiprocket.in/v1/external';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

async function getToken() {
  const email    = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;
  if (!email || !password) throw new Error('SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD not set');
  const res  = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok || !data.token) throw new Error(`Shiprocket auth failed: ${JSON.stringify(data)}`);
  return data.token;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;

  const body = JSON.parse(event.body || '{}');
  const ids  = Array.isArray(body.order_ids) ? body.order_ids.filter(Boolean) : [];
  if (!ids.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide order_ids: ["IC-..."]' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase
    .from('orders')
    .select('razorpay_order_id, status, tracking_id, shiprocket_order_id, customer_name, amount_paise')
    .in('razorpay_order_id', ids);
  if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };

  const found   = data || [];
  const target  = [];
  const refused = [];

  for (const id of ids) {
    const o = found.find(r => r.razorpay_order_id === id);
    if (!o)                      { refused.push({ order_id: id, reason: 'no such order' }); continue; }
    if (!o.shiprocket_order_id)  { refused.push({ order_id: id, reason: 'not in Shiprocket' }); continue; }
    if (o.tracking_id)           { refused.push({ order_id: id, reason: `courier already assigned AWB ${o.tracking_id} — raise a return instead` }); continue; }
    target.push(o);
  }

  const rows = target.map(o => ({
    order_id:            o.razorpay_order_id,
    shiprocket_order_id: o.shiprocket_order_id,
    customer:            o.customer_name,
    status:              o.status,
    amount:              Math.round((o.amount_paise || 0) / 100),
  }));

  if (body.dry_run) {
    return { statusCode: 200, headers: CORS,
             body: JSON.stringify({ dry_run: true, would_cancel: rows, refused }, null, 2) };
  }

  if (!target.length) {
    return { statusCode: 200, headers: CORS,
             body: JSON.stringify({ cancelled: 0, rows: [], refused }, null, 2) };
  }

  const token = await getToken();
  const res   = await fetch(`${BASE}/orders/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ids: target.map(o => Number(o.shiprocket_order_id)) }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { statusCode: 502, headers: CORS,
             body: JSON.stringify({ error: 'Shiprocket cancel failed', response: out, attempted: rows }, null, 2) };
  }

  return { statusCode: 200, headers: CORS,
           body: JSON.stringify({ cancelled: rows.length, rows, refused, response: out }, null, 2) };
};
