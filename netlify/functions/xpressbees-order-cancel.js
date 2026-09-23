/**
 * Netlify Function: xpressbees-order-cancel
 * POST /.netlify/functions/xpressbees-order-cancel
 *
 * Body: { dry_run: true,
 *         order_ids: ["IC-..."] | all_delhivery_today: true,
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
 * THREE GUARDS, none of them bypassable by any flag:
 *
 *   1. Delhivery must actually be carrying it -- courier_name Delhivery AND a
 *      tracking_id. Without this the endpoint would happily cancel live work.
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
const MAX_PAGES  = 4;
const BATCH      = 20;    // ids per cancel call

/** Panel numbers carry re-book suffixes (-p, -c, -c2, -r1); ours do not. */
function baseOrderNumber(n) {
  return String(n || '').trim().toUpperCase().replace(/-(P|C\d*|D|R\d*)$/i, '');
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

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // ---- our side: which orders is Delhivery carrying? ----
  let q = supabase.from('orders')
    .select('id, razorpay_order_id, status, courier_name, tracking_id, awb_assigned_at')
    .eq('courier_name', 'Delhivery')
    .not('tracking_id', 'is', null);

  if (body.all_delhivery_today) {
    const day = String(body.day || new Date().toISOString().slice(0, 10));
    q = q.gte('awb_assigned_at', `${day}T00:00:00Z`).lt('awb_assigned_at', `${day}T23:59:59.999Z`);
  }

  const { data: rows, error } = await q.limit(1000);
  if (error) return json(500, { error: `orders query failed: ${error.message}` });

  let carried = new Map();
  for (const o of rows || []) {
    const num = String(o.razorpay_order_id || o.id).toUpperCase();
    carried.set(num, o);
  }

  // An explicit list narrows the set; it can never widen past guard 1.
  if (Array.isArray(body.order_ids) && body.order_ids.length) {
    const want = new Set(body.order_ids.map((s) => String(s).trim().toUpperCase()));
    const refusedNotCarried = [...want].filter((id) => !carried.has(id));
    carried = new Map([...carried].filter(([id]) => want.has(id)));
    if (refusedNotCarried.length && body.strict !== false) {
      return json(400, {
        error: 'some ids are not carried by Delhivery; refusing the whole batch',
        refused: refusedNotCarried,
      });
    }
  }

  // ---- their side: read the panel ----
  const seen = new Set();
  const panel = [];
  try {
    for (let p = 1; p <= MAX_PAGES; p += 1) {
      const out = await xb.panelOrders({
        params: { limit: String(PAGE_LIMIT), page_no: String(p) },
      });
      const fresh = out.rows.filter((r) => !seen.has(String(r.id)));
      for (const r of out.rows) seen.add(String(r.id));
      panel.push(...fresh);
      if (!fresh.length) break;
    }
  } catch (e) {
    return json(502, { error: `could not read the XpressBees order list: ${e.message}` });
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
    });
  }
  targets.sort((a, b) => (a.order < b.order ? -1 : 1));

  const inPanel = new Set(panel.map((r) => baseOrderNumber(r.order_number)));
  const neverImported = [...carried.keys()].filter((id) => !inPanel.has(id)).sort();

  const plan = targets.slice(0, limit);
  const summary = {
    dry_run: dryRun,
    endpoint,
    panel_rows_read: panel.length,
    delhivery_carried: carried.size,
    to_cancel: plan.length,
    skipped_already_cancelled: skipped.already_cancelled.length,
    skipped_has_awb: skipped.has_awb.length,
    never_imported: neverImported.length,
  };

  if (dryRun) {
    return json(200, { ...summary, plan, skipped, never_imported: neverImported });
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
      out = await xb.withAuth((token) => xb.xbFetch(endpoint, {
        method: 'POST', token, body: { id: ids.join(',') },
      }));
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
