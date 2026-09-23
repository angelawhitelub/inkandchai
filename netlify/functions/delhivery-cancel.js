/**
 * Netlify Function: delhivery-cancel
 * POST /.netlify/functions/delhivery-cancel
 *
 * Body: { order_ids: ["IC-..."] }   { dry_run: true }
 * Headers: X-Admin-Key / X-Admin-Token
 *
 * Cancels a Delhivery booking and releases the order so it can be booked
 * again. Delhivery allows this from Manifested, In Transit and Pending.
 *
 * SENDS NOTHING TO THE CUSTOMER. This path never touches order status, which
 * is what the shipping notifications key off, so cancelling and re-booking is
 * invisible to them -- which is the point when the re-book is our own
 * correction rather than anything that happened to their parcel.
 *
 * On success the AWB fields are cleared, because tracking_id is what every
 * other courier path checks before refusing an order. Leaving a cancelled
 * waybill there would lock the order out of being re-shipped by anyone.
 * The old waybill is filed in previous_tracking_ids as a separate write, so
 * that if that column is a type this does not expect, the clearing update --
 * the one that matters -- has already landed.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;

  const body = JSON.parse(event.body || '{}');
  const ids  = Array.isArray(body.order_ids) ? body.order_ids.filter(Boolean) : [];
  if (!ids.length) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide order_ids' }) };

  const token = process.env.DELHIVERY_API_TOKEN;
  if (!token) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'DELHIVERY_API_TOKEN not set' }) };
  const base = process.env.DELHIVERY_BASE || 'https://track.delhivery.com';

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase
    .from('orders')
    .select('id, razorpay_order_id, status, tracking_id, courier_name, previous_tracking_ids')
    .in('razorpay_order_id', ids);
  if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };

  const rows = data || [];
  const target = [], refused = [];
  for (const id of ids) {
    const o = rows.find(r => r.razorpay_order_id === id);
    if (!o)               { refused.push({ order_id: id, reason: 'no such order' }); continue; }
    if (!o.tracking_id)   { refused.push({ order_id: id, reason: 'no AWB on this order' }); continue; }
    if (String(o.courier_name || '').toLowerCase() !== 'delhivery') {
      refused.push({ order_id: id, reason: `AWB belongs to ${o.courier_name || 'another courier'} — cancel it there` });
      continue;
    }
    target.push(o);
  }

  if (body.dry_run) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      dry_run: true,
      would_cancel: target.map(o => ({ order_id: o.razorpay_order_id, awb: o.tracking_id, status: o.status })),
      refused }, null, 2) };
  }

  const results = [];
  for (const o of target) {
    const id = o.razorpay_order_id;
    let out;
    try {
      const res = await fetch(`${base}/api/p/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Token ${token}` },
        body: JSON.stringify({ waybill: String(o.tracking_id), cancellation: 'true' }),
      });
      const text = await res.text();
      try { out = JSON.parse(text); } catch { out = { raw: text.slice(0, 200) }; }
      if (!res.ok || out.status === false || out.error) {
        results.push({ order_id: id, awb: o.tracking_id, cancelled: false, response: out });
        continue;
      }
    } catch (e) {
      results.push({ order_id: id, awb: o.tracking_id, cancelled: false, error: String(e.message || e) });
      continue;
    }

    const { error: upErr } = await supabase.from('orders').update({
      tracking_id: null, courier_name: null, tracking_url: null, awb_assigned_at: null,
    }).eq('id', o.id);

    // Separate, best-effort: the history column must never be able to take the
    // clearing update down with it.
    let filed = false;
    try {
      const prev = Array.isArray(o.previous_tracking_ids) ? o.previous_tracking_ids : [];
      const { error: hErr } = await supabase.from('orders')
        .update({ previous_tracking_ids: [...prev, String(o.tracking_id)] }).eq('id', o.id);
      filed = !hErr;
    } catch { filed = false; }

    results.push({ order_id: id, awb: o.tracking_id, cancelled: true,
                   released: !upErr, awb_filed: filed,
                   release_error: upErr ? upErr.message : undefined, response: out });
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({
    cancelled: results.filter(r => r.cancelled).length, results, refused }, null, 2) };
};
