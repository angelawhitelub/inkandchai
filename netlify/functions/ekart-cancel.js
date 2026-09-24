/**
 * Netlify Function: ekart-cancel
 * POST /.netlify/functions/ekart-cancel
 *
 * Body: { order_ids: ["IC-..."] }   { dry_run: true }
 * Headers: X-Admin-Key / X-Admin-Token
 *
 * Cancels an Ekart waybill and releases the order so it can be booked again.
 * The Delhivery twin of this lives in delhivery-cancel.js; everything below
 * follows it deliberately, because the invariants are the same ones.
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
 *
 * REFUSES an AWB that belongs to another courier. Cancelling a Delhivery
 * waybill through Ekart's API cannot work, but clearing our columns anyway
 * would leave a live parcel with nothing pointing at it.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const ek = require('./utils/ekart');

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
    if (!o)             { refused.push({ order_id: id, reason: 'no such order' }); continue; }
    if (!o.tracking_id) { refused.push({ order_id: id, reason: 'no AWB on this order' }); continue; }
    if (String(o.courier_name || '').toLowerCase() !== 'ekart') {
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
      out = await ek.cancelShipment(o.tracking_id);
      const d = out.data || {};
      // Their error CODE is in `message`; the readable half is in
      // `description` -- see utils/ekart.js. Reporting only the code turns
      // every distinct failure into the same opaque string.
      if (out.httpStatus !== 200 || d.status === false) {
        results.push({ order_id: id, awb: o.tracking_id, cancelled: false,
                       http: out.httpStatus,
                       error: d.description || d.remark || d.message || out.raw,
                       code: d.message || null });
        continue;
      }
    } catch (e) {
      results.push({ order_id: id, awb: o.tracking_id, cancelled: false, error: String(e.message || e) });
      continue;
    }

    const { error: upErr } = await supabase.from('orders').update({
      tracking_id: null, courier_name: null, tracking_url: null, awb_assigned_at: null,
    }).eq('id', o.id);

    let filed = false;
    try {
      const prev = Array.isArray(o.previous_tracking_ids) ? o.previous_tracking_ids : [];
      const { error: hErr } = await supabase.from('orders')
        .update({ previous_tracking_ids: [...prev, String(o.tracking_id)] }).eq('id', o.id);
      filed = !hErr;
    } catch { filed = false; }

    results.push({ order_id: id, awb: o.tracking_id, cancelled: true,
                   released: !upErr, awb_filed: filed,
                   release_error: upErr ? upErr.message : undefined });
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({
    cancelled: results.filter(r => r.cancelled).length, results, refused }, null, 2) };
};
