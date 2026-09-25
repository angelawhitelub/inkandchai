/**
 * Netlify Function: xpressbees-order-cancel
 * POST /.netlify/functions/xpressbees-order-cancel
 *
 * Body: { dry_run: true,
 *         order_ids: ["IC-..."] | all_delhivery_today: true | any_courier: true,
 *         limit: 50, endpoint: "/orders/cancel", probe: false }
 * Headers: X-Admin-Key / X-Admin-Token
 *
 * Cancels UNBOOKED orders sitting in the XpressBees panel queue -- the rows
 * their channel importer pulled from our WooCommerce feed and that nobody has
 * turned into a shipment. Delhivery is already carrying these sales; leaving
 * them bookable in a second panel is how the same parcel goes out twice, with
 * COD collected twice on the ones that carry money.
 *
 * SENDS NOTHING TO THE CUSTOMER and does not touch our own order rows. The
 * order is already shipped by Delhivery as far as our books and the customer
 * are concerned; this only clears the duplicate from someone else's queue.
 *
 * any_courier: true widens guard 1 from "Delhivery is carrying it" to "SOME
 * courier is carrying it" -- a tracking_id on an order that is not cancelled.
 * Every other panel row is left alone, and guards 2 and 3 are unchanged.
 *
 * THREE GUARDS, none of them bypassable by any flag:
 *
 *   1. A courier must actually be carrying it -- a tracking_id, from Delhivery
 *      unless any_courier widens it. Without this the endpoint would happily
 *      cancel live work.
 *   2. The panel row must have NO awb_numbers. A row with a waybill is a real
 *      XpressBees shipment; killing that is a different decision with a real
 *      parcel behind it, and it belongs to /shipments2/cancel, not here.
 *   3. Rows already cancelled are skipped, not re-sent.
 *
 * The panel's own list endpoint pages with `limit` and `page_no` (NOT the
 * `per_page`/`page` the REST docs imply -- those are ignored and you get the
 * newest 50 forever, which is what made this look unpageable).
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const xb = require('./utils/xpressbees');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body, null, 2) });

const PAGE_LIMIT = 200;   // 300 times out upstream; 200 is comfortably inside it
const MAX_PAGES  = 25;  // stops at the first page with nothing new
// One id per call. The panel's own v2 bundle joins ids with commas, but this
// (legacy) endpoint answers a list with 404 "The id field must contain an
// integer" -- so a batch cancels nothing at all rather than part of itself.
const BATCH      = 1;

/** Panel numbers carry re-book suffixes (-p, -c, -c2, -r1); ours do not. */
function baseOrderNumber(n) {
  return String(n || '').trim().toUpperCase().replace(/-(P|C\d*|D|R\d*)$/i, '');
}

/**
 * The panel rejects an application/json body here with a 404 and the bare
 * message "id is required" -- the same quirk NimbusPost's panel has, where
 * this endpoint reads only form-encoded input. So the id list goes out as a
 * form, and `shape` stays configurable because that is a guess about someone
 * else's server, not a fact we control.
 */
async function postIds(path, token, ids, shape) {
  const url = `${xb.XB_BASE}${path}`;
  const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  let body;
  if (shape === 'multipart') {
    body = new FormData();
    body.append('id', ids.join(','));           // fetch sets the boundary itself
  } else if (shape === 'json') {
    body = JSON.stringify({ id: ids.join(',') });
    headers['Content-Type'] = 'application/json';
  } else {
    body = new URLSearchParams({ id: ids.join(',') }).toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const res = await fetch(url, { method: 'POST', headers, body });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* raw below */ }
  return { httpStatus: res.status, data, raw: text.slice(0, 400) };
}

const isCancelled = (row) => String(row.status || '').toLowerCase() === 'cancelled';
const hasAwb = (row) => String(row.awb_numbers || '').trim() !== '';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS);
  if (block) return block;
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const dryRun = body.dry_run !== false;
  const endpoint = String(body.endpoint || '/orders/cancel');
  const limit = Math.max(1, Math.min(200, Number(body.limit) || 200));
  const shape = String(body.shape || 'form');

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const anyCourier = body.any_courier === true;

  // ---- their side: read the panel ----
  const seen = new Set();
  const panel = [];
  try {
    for (let p = 1; p <= MAX_PAGES; p += 1) {
      let out;
      try {
        out = await xb.panelOrders({
          params: { limit: String(PAGE_LIMIT), page_no: String(p) },
        });
      } catch (e) {
        // Past the last page the panel answers status:false "No data Found."
        // rather than an empty page. On page 1 that is a real failure.
        if (p > 1 && /no data found/i.test(e.message)) break;
        throw e;
      }
      const fresh = out.rows.filter((r) => !seen.has(String(r.id)));
      for (const r of out.rows) seen.add(String(r.id));
      panel.push(...fresh);
      if (!fresh.length) break;
    }
  } catch (e) {
    return json(502, { error: `could not read the XpressBees order list: ${e.message}` });
  }

  // ---- our side: which of those orders is a courier already carrying? ----
  let carried = new Map();
  const leftAlone = { cancelled_here: [], not_shipped_here: [], not_in_our_orders: [] };
  if (anyCourier) {
    // Ask only about the orders actually queued there (tens to hundreds), not
    // every shipped order we have ever had.
    const queued = [...new Set(panel
      .filter((r) => !isCancelled(r) && !hasAwb(r))
      .map((r) => baseOrderNumber(r.order_number)).filter(Boolean))];
    const found = new Set();
    for (let i = 0; i < queued.length; i += 150) {
      const { data, error: qErr } = await supabase.from('orders')
        .select('id, razorpay_order_id, status, courier_name, tracking_id, awb_assigned_at')
        .in('razorpay_order_id', queued.slice(i, i + 150));
      if (qErr) return json(500, { error: `orders query failed: ${qErr.message}` });
      for (const o of data || []) {
        const num = String(o.razorpay_order_id).toUpperCase();
        found.add(num);
        // An AWB on an order we cancelled is a booking that never went out --
        // not "already shipped". Report it, never act on it.
        if (String(o.status) === 'cancelled') leftAlone.cancelled_here.push(num);
        else if (!String(o.tracking_id || '').trim()) leftAlone.not_shipped_here.push(num);
        else carried.set(num, o);
      }
    }
    leftAlone.not_in_our_orders = queued.filter((n) => !found.has(n.toUpperCase()));
  }

  let q = supabase.from('orders')
    .select('id, razorpay_order_id, status, courier_name, tracking_id, awb_assigned_at')
    .eq('courier_name', 'Delhivery')
    .not('tracking_id', 'is', null);

  if (body.all_delhivery_today) {
    const day = String(body.day || new Date().toISOString().slice(0, 10));
    q = q.gte('awb_assigned_at', `${day}T00:00:00Z`).lt('awb_assigned_at', `${day}T23:59:59.999Z`);
  }

  if (!anyCourier) {
    const { data: rows, error } = await q.limit(1000);
    if (error) return json(500, { error: `orders query failed: ${error.message}` });
    for (const o of rows || []) {
      const num = String(o.razorpay_order_id || o.id).toUpperCase();
      carried.set(num, o);
    }
  }

  // An explicit list narrows the set; it can never widen past guard 1.
  if (Array.isArray(body.order_ids) && body.order_ids.length) {
    const want = new Set(body.order_ids.map((s) => String(s).trim().toUpperCase()));
    const refusedNotCarried = [...want].filter((id) => !carried.has(id));
    carried = new Map([...carried].filter(([id]) => want.has(id)));
    if (refusedNotCarried.length && body.strict !== false) {
      return json(400, {
        error: `some ids are not carried by ${anyCourier ? 'any courier' : 'Delhivery'}; refusing the whole batch`,
        refused: refusedNotCarried,
      });
    }
  }

  // ---- match ----
  const targets = [];
  const skipped = { already_cancelled: [], has_awb: [] };
  for (const row of panel) {
    const base = baseOrderNumber(row.order_number);
    if (!carried.has(base)) continue;
    if (isCancelled(row)) { skipped.already_cancelled.push(base); continue; }
    if (hasAwb(row))      { skipped.has_awb.push({ order: base, awb: row.awb_numbers }); continue; }
    targets.push({
      order: base,
      panel_id: String(row.id),
      status: row.status,
      amount: row.order_amount,
      payment: row.payment_method,
      carried_by: carried.get(base).courier_name || '',
      our_status: carried.get(base).status,
    });
  }
  targets.sort((a, b) => (a.order < b.order ? -1 : 1));

  const inPanel = new Set(panel.map((r) => baseOrderNumber(r.order_number)));
  const neverImported = [...carried.keys()].filter((id) => !inPanel.has(id)).sort();

  const plan = targets.slice(0, limit);
  const summary = {
    dry_run: dryRun,
    endpoint,
    shape,
    panel_rows_read: panel.length,
    mode: anyCourier ? 'any_courier' : 'delhivery',
    carried: carried.size,
    to_cancel: plan.length,
    skipped_already_cancelled: skipped.already_cancelled.length,
    skipped_has_awb: skipped.has_awb.length,
    never_imported: neverImported.length,
  };

  if (dryRun) {
    return json(200, { ...summary, plan, skipped, left_alone: anyCourier ? leftAlone : undefined,
      never_imported: anyCourier ? undefined : neverImported });
  }

  // ---- cancel ----
  // One id first when probing, so an unknown response shape costs one row.
  const groups = body.probe ? [plan.slice(0, 1)] : [];
  if (!body.probe) for (let i = 0; i < plan.length; i += BATCH) groups.push(plan.slice(i, i + BATCH));

  const results = [];
  for (const group of groups) {
    const ids = group.map((t) => t.panel_id);
    let out;
    try {
      out = await xb.withAuth((token) => postIds(endpoint, token, ids, shape));
    } catch (e) {
      results.push({ ids, ok: false, error: e.message });
      continue;
    }
    const d = out.data || {};
    const ok = d.status === true || d.status === 'success' || d.code === 201 || out.httpStatus === 200;
    results.push({
      orders: group.map((t) => t.order),
      ids,
      http: out.httpStatus,
      ok,
      message: d.message || d.error || out.raw,
    });
  }

  return json(200, { ...summary, results, skipped, never_imported: neverImported });
};
