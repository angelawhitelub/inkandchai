/**
 * Netlify Function: admin-xb-reconcile   (owner)
 *
 * "Is everything XpressBees has booked shown as shipped in our admin?"
 * Reads every XpressBees shipment of the last N days from the panel's own
 * list (the same API as the label download), matches each to our order by
 * AWB, then by order number, and sorts them:
 *
 *   ok            our order carries this AWB and is shipped or later
 *   status_stale  our order carries this AWB but still says paid / COD pending   (fixable)
 *   awb_missing   our order has no AWB at all: the push-back never arrived     (fixable)
 *   other_awb     our order carries a DIFFERENT AWB: booked twice, or re-booked  (report only)
 *   order_closed  our order is cancelled / refunded but XpressBees has it live  (report only)
 *   not_found     no order of ours matches                                       (report only)
 *
 *   GET  ?days=30                      → the report. Changes nothing.
 *   POST { apply: true, order_ids, days }
 *        Re-reads everything, then fixes ONLY the named orders that are still
 *        status_stale / awb_missing: AWB + courier + tracking link + status
 *        'shipped'. The customer gets the shipped email + WhatsApp when the
 *        order was never marked shipped before (shipped_at empty), as on any
 *        other booking. Nothing is ever cancelled or booked at XpressBees.
 */
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { makeCaller } = require('./admin-xpressbees-labels').lib;
const { buildTrackingUrl } = require('./utils/tracking-url');
const { sendShippedNotification } = require('./utils/shipped-notification');
const { baseOrderNumber } = require('./utils/booking-guard');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const PAGE = 100;
const MAX_PAGES = 80;
const COURIER = 'XpressBees';
const UNSHIPPED = ['paid', 'confirmed', 'cod_pending', 'partial_cod_pending', 'replacement_pending'];
const CLOSED = ['cancelled', 'refunded', 'refund_pending', 'refund_failed'];
const XB_DEAD = /cancel/i;

const lc = (s) => String(s || '').trim().toLowerCase();
/** Where the panel puts our order number; its record shape is not documented. */
const orderNumberOf = (r) => String(r.order_number || r.order_id || r.client_order_id || r.reference_number || r.order_no || '').trim();

async function xbShipments(call, { days }) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 24 * 60 * 60;
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const qs = new URLSearchParams({ limit: String(PAGE), page: String(page), start_date: String(start), end_date: String(end) });
    const out = await call(`/shipment/list?${qs}`);
    const recs = out.data?.data?.records;
    if (out.httpStatus !== 200 || !Array.isArray(recs)) {
      throw new Error(`XpressBees shipment list failed (HTTP ${out.httpStatus}): ${out.data?.message || out.raw}`);
    }
    rows.push(...recs);
    if (recs.length < PAGE) break;
  }
  const seen = new Set();
  return rows.filter((r) => {
    const awb = String(r.awb_number || '').trim();
    if (!awb || seen.has(awb)) return false;
    seen.add(awb);
    return true;
  });
}

async function ordersBy(supabase, column, values) {
  const out = [];
  const list = [...new Set(values.filter(Boolean))];
  for (let i = 0; i < list.length; i += 150) {
    const { data, error } = await supabase.from('orders')
      .select('id,razorpay_order_id,status,tracking_id,courier_name,shipped_at,customer_name,customer_email,customer_phone,cart_items,amount_paise,created_at,source')
      .in(column, list.slice(i, i + 150));
    if (error) throw new Error(`orders: ${error.message}`);
    out.push(...(data || []));
  }
  return out;
}

/** Pure: shipments + our orders → one row per live XpressBees shipment, classified. */
function classify(shipments, byAwb, byNumber) {
  const rows = [];
  for (const s of shipments) {
    const awb = String(s.awb_number).trim();
    const xbStatus = String(s.ship_status || s.status || '').trim();
    if (XB_DEAD.test(xbStatus)) continue;
    const number = orderNumberOf(s);
    const o = byAwb.get(awb) || byNumber.get(baseOrderNumber(number)) || null;
    const st = o ? lc(o.status) : '';
    const ourAwb = o ? String(o.tracking_id || '').trim() : '';
    let kind;
    if (!o) kind = 'not_found';
    else if (CLOSED.includes(st)) kind = 'order_closed';
    else if (ourAwb && ourAwb !== awb) kind = 'other_awb';
    else if (ourAwb === awb) kind = UNSHIPPED.includes(st) ? 'status_stale' : 'ok';
    else kind = UNSHIPPED.includes(st) ? 'awb_missing' : 'other_awb';
    rows.push({
      kind,
      awb,
      xb_status: xbStatus || null,
      xb_order: number || null,
      order_id: o ? o.razorpay_order_id : null,
      our_status: o ? o.status : null,
      our_awb: ourAwb || null,
      our_courier: o ? o.courier_name || null : null,
      customer: o ? o.customer_name || null : null,
      notify: !!o && !o.shipped_at,
      _order: o,
    });
  }
  return rows;
}

async function report(supabase, call, { days }) {
  const shipments = await xbShipments(call, { days });
  const awbOrders = await ordersBy(supabase, 'tracking_id', shipments.map((s) => String(s.awb_number).trim()));
  const byAwb = new Map(awbOrders.map((o) => [String(o.tracking_id).trim(), o]));
  const numbers = shipments.filter((s) => !byAwb.has(String(s.awb_number).trim())).map(orderNumberOf).filter(Boolean);
  const wanted = [...new Set(numbers.flatMap((n) => [n, baseOrderNumber(n), n.replace(/-(P|C\d*|D|R\d*)$/i, '')]))];
  const numOrders = await ordersBy(supabase, 'razorpay_order_id', wanted);
  const byNumber = new Map(numOrders.map((o) => [String(o.razorpay_order_id).toUpperCase(), o]));
  const rows = classify(shipments, byAwb, byNumber);
  const counts = rows.reduce((m, r) => { m[r.kind] = (m[r.kind] || 0) + 1; return m; }, {});
  const xbStatuses = rows.reduce((m, r) => { m[r.xb_status || '?'] = (m[r.xb_status || '?'] || 0) + 1; return m; }, {});
  return {
    days,
    xb_shipments: shipments.length,
    live: rows.length,
    counts,
    xb_statuses: xbStatuses,
    record_keys: shipments[0] ? Object.keys(shipments[0]).slice(0, 40) : [],
    rows,
  };
}

/** Fix one order: AWB + shipped, only if it is still unshipped and has no other AWB. */
async function applyOne(supabase, row, deps = {}) {
  const o = row._order;
  const now = new Date().toISOString();
  const update = {
    status: 'shipped',
    tracking_id: row.awb,
    courier_name: o.courier_name && row.kind === 'status_stale' ? o.courier_name : COURIER,
    tracking_url: buildTrackingUrl({ courier: COURIER, awb: row.awb, orderNumber: o.razorpay_order_id }),
    ...(o.shipped_at ? {} : { shipped_at: now }),
    awb_assigned_at: now,
  };
  let q = supabase.from('orders').update(update).eq('id', o.id).in('status', UNSHIPPED);
  q = row.kind === 'awb_missing' ? q.is('tracking_id', null) : q.eq('tracking_id', row.awb);
  const { data, error } = await q.select('id');
  if (error) return { order_id: o.razorpay_order_id, ok: false, error: error.message };
  if (!data || !data.length) return { order_id: o.razorpay_order_id, ok: false, error: 'changed since the check; left alone' };
  let notified = null;
  if (row.notify) {
    const send = deps.sendShippedNotification || sendShippedNotification;
    notified = await send({ ...o, ...update }, { awb: row.awb, courier: COURIER, trackingUrl: update.tracking_url })
      .catch((e) => ({ error: e.message }));
  }
  return { order_id: o.razorpay_order_id, ok: true, awb: row.awb, notified: !!notified && !notified.error, notify_error: notified && notified.error };
}

const publicRow = ({ _order, ...r }) => r;

exports.handler = async (event = {}) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;
  const qs = event.queryStringParameters || {};
  let body = {};
  if (event.httpMethod === 'POST') {
    try { body = JSON.parse(event.body || '{}') || {}; } catch { return json(400, { error: 'Invalid JSON' }); }
  } else if (event.httpMethod !== 'GET') {
    return json(405, { error: 'GET or POST only' });
  }
  const days = Math.max(1, Math.min(90, Number(body.days || qs.days) || 30));
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const out = await report(supabase, makeCaller({}), { days });
    if (event.httpMethod === 'GET' || body.apply !== true) {
      return json(200, { ...out, rows: out.rows.filter((r) => r.kind !== 'ok').map(publicRow) });
    }
    const named = new Set((Array.isArray(body.order_ids) ? body.order_ids : []).map((s) => String(s).trim().toUpperCase()));
    if (!named.size) return json(400, { error: 'Pass order_ids: the orders to fix, from the check.' });
    const results = [];
    for (const r of out.rows) {
      if (!['status_stale', 'awb_missing'].includes(r.kind)) continue;
      if (!named.has(String(r.order_id).toUpperCase())) continue;
      named.delete(String(r.order_id).toUpperCase());
      results.push(await applyOne(supabase, r));
    }
    for (const id of named) results.push({ order_id: id, ok: false, error: 'no longer needs fixing (or not in the check)' });
    return json(200, { applied: results.filter((r) => r.ok).length, results });
  } catch (e) {
    console.error('[admin-xb-reconcile]', e);
    return json(e.status || 500, { error: e.message });
  }
};

exports._test = { classify, applyOne, orderNumberOf };
