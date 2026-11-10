/**
 * Netlify Function: admin-double-bookings   (owner, READ-ONLY)
 *
 * "What else has been sent twice?" Reads the XpressBees panel's own order
 * list and our orders, and lists every order that has more than one live
 * parcel, or a live XpressBees booking next to another courier's AWB or panel
 * push. Changes nothing, cancels nothing, messages nobody.
 *
 *   GET → {
 *     scanned_rows, panel_orders,
 *     doubles:     [{ order_id, why[], xb_awbs[], our_awb, our_courier, status, ... }],
 *     awb_missing: [{ order_id, ... }]   // XpressBees booked, AWB never reached us
 *   }
 *
 * The panel's AWB field is often blank on booked rows, so "booked" is read
 * from the row status (see utils/booking-guard.js panelState).
 */
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const xb = require('./utils/xpressbees');
const { baseOrderNumber, panelState, shiprocketActive } = require('./utils/booking-guard');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const PAGE_LIMIT = 200;
const MAX_PAGES = 25;
const isXb = (name) => /xpress\s*bees|xbees/i.test(String(name || ''));
const awbsOf = (row) => String(row.awb_numbers || row.awb_number || '')
  .split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

async function readPanel(panelOrders) {
  const seen = new Set();
  const rows = [];
  for (let p = 1; p <= MAX_PAGES; p += 1) {
    let out;
    try { out = await panelOrders({ params: { limit: String(PAGE_LIMIT), page_no: String(p) } }); }
    catch (e) { if (p > 1 && /no data found/i.test(e.message)) break; throw e; }
    const fresh = (out.rows || []).filter((r) => !seen.has(String(r.id)));
    for (const r of out.rows || []) seen.add(String(r.id));
    rows.push(...fresh);
    if (!fresh.length) break;
  }
  return rows;
}

/** Pure: panel rows + our orders → the report. */
function analyse(panelRows, ordersById) {
  const groups = new Map();
  for (const r of panelRows) {
    const key = baseOrderNumber(r.order_number);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const doubles = [];
  const awbMissing = [];
  for (const [key, rows] of groups) {
    const live = rows.filter((r) => panelState(r) === 'booked');
    if (!live.length) continue;
    const xbAwbs = [...new Set(live.flatMap(awbsOf))];
    const o = ordersById.get(key);
    const ourAwb = o ? String(o.tracking_id || '').trim() : '';
    const why = [];
    if (live.length > 1 || xbAwbs.length > 1) {
      why.push(`${Math.max(live.length, xbAwbs.length)} live XpressBees bookings`);
    }
    if (o && ourAwb && !xbAwbs.includes(ourAwb) && !isXb(o.courier_name)) {
      why.push(`also booked with ${o.courier_name || 'another courier'} ${ourAwb}`);
    }
    if (o && !ourAwb && o.nimbus_pushed_at) why.push('also pushed to the NimbusPost panel');
    if (o && !ourAwb && o.ithink_pushed_at) why.push('also pushed to iThink');
    if (o && !ourAwb && o.shiprocket_order_id && shiprocketActive()) why.push(`also in Shiprocket (${o.shiprocket_order_id})`);
    const row = {
      order_id: o ? o.razorpay_order_id : key,
      xb_awbs: xbAwbs,
      xb_rows: live.map((r) => ({ number: r.order_number, status: r.status, awb: awbsOf(r).join(',') || null })),
      our_awb: ourAwb || null,
      our_courier: o ? o.courier_name || null : null,
      status: o ? o.status : 'not in our orders',
      payment: o ? o.shipment_payment_type || o.payment_method || null : null,
      customer: o ? o.customer_name || null : null,
      created_at: o ? o.created_at : null,
    };
    if (why.length) doubles.push({ ...row, why });
    else if (o && !ourAwb) awbMissing.push(row);
  }
  const byDate = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));
  return { doubles: doubles.sort(byDate), awb_missing: awbMissing.sort(byDate), panel_orders: groups.size };
}

async function loadOrders(supabase, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await supabase.from('orders')
      .select('*')
      .in('razorpay_order_id', ids.slice(i, i + 150));
    if (error) throw new Error(`orders: ${error.message}`);
    for (const o of data || []) out.set(String(o.razorpay_order_id).toUpperCase(), o);
  }
  return out;
}

exports.handler = async (event = {}) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });
  try {
    const panelRows = await readPanel(xb.panelOrders);
    // Both spellings: our ids are upper-case IC-..., older ones are order_... .
    const ids = [...new Set(panelRows.filter((r) => panelState(r) === 'booked').flatMap((r) => [
      baseOrderNumber(r.order_number),
      String(r.order_number || '').trim().replace(/-(P|C\d*|D|R\d*)$/i, ''),
    ]).filter(Boolean))];
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const orders = await loadOrders(supabase, ids);
    const report = analyse(panelRows, orders);
    return json(200, { scanned_rows: panelRows.length, ...report, read_at: new Date().toISOString() });
  } catch (e) {
    console.error('[admin-double-bookings]', e);
    return json(500, { error: e.message });
  }
};

exports._test = { analyse, readPanel };
