/**
 * Netlify Function: admin-nimbuspost-cancelled
 * GET /.netlify/functions/admin-nimbuspost-cancelled?pages=5
 *
 * Admin endpoint — the orders NimbusPost cancelled on its side that we have NOT
 * cancelled on ours.
 *
 * Why this exists: when NimbusPost auto-cancels a shipment it reverses the
 * freight into the wallet and moves on. Nothing tells us. The order sits at
 * `shipped` in our database and in the customer's My Orders page for days, the
 * customer is never notified, and a prepaid customer never gets their money
 * back — until somebody notices a wallet CSV and reconciles it by hand. That
 * hand-reconciliation is what this replaces.
 *
 * Read-only. It reports; it never cancels or refunds. Acting on the list goes
 * through bulk-update-orders (status=cancelled), the same chokepoint the admin
 * panel already uses, which fires the auto-refund and the customer notice.
 * Keeping the money action there means there is still exactly ONE cancellation
 * path, and this endpoint stays safe for a support-role login to open.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const {
  listNimbusOrders, rowIsCancelled, shipmentStatusFromRow,
  orderNumberFromRow, awbFromRow,
} = require('./utils/nimbuspost-cancel');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

// Already dealt with — cancelled, or somewhere in the refund pipeline. Listing
// these again would invite a second cancellation on an order that already has
// a refund in flight.
const SETTLED = ['cancelled', 'refunded', 'refund_pending', 'partially_refunded'];

function cartOf(order) {
  let cart = order.cart_items;
  if (typeof cart === 'string') { try { cart = JSON.parse(cart); } catch (_) { cart = []; } }
  return Array.isArray(cart) ? cart : [];
}

function isReplacement(order) {
  return String(order.source || '').toLowerCase() === 'replacement'
    || /^IC-R-/i.test(String(order.razorpay_order_id || ''));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const denied = requireAdmin(event, CORS);
  if (denied) return denied;

  const key = process.env.NIMBUSPOST_API_KEY;
  if (!key) {
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: 'NIMBUSPOST_API_KEY not configured' }) };
  }

  // 100 rows a page. 5 pages is roughly a fortnight of volume and comfortably
  // inside the function timeout; the panel can ask for more when reconciling
  // further back.
  const pages = Math.min(Math.max(Number(event.queryStringParameters?.pages) || 5, 1), 15);

  let rows;
  try {
    rows = await listNimbusOrders(key, pages);
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: `NimbusPost: ${e.message}` }) };
  }

  const cancelled = rows.filter(rowIsCancelled);
  if (!cancelled.length) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, scanned: rows.length, pages, cancelled_at_nimbus: 0, orders: [], totals: emptyTotals() }),
    };
  }

  // Match on our own order id first (we send it as order_number on push, so it
  // is the reliable key) and fall back to the AWB for anything pushed before
  // that, or created directly in the panel.
  const byOrderNumber = new Map();
  const byAwb = new Map();
  for (const row of cancelled) {
    const num = orderNumberFromRow(row);
    const awb = awbFromRow(row);
    if (num) byOrderNumber.set(num, row);
    if (awb) byAwb.set(awb, row);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const cols = 'id,razorpay_order_id,razorpay_payment_id,tracking_id,courier_name,status,amount_paise,'
    + 'advance_paid_paise,customer_name,customer_phone,customer_email,cart_items,created_at,source,'
    + 'shipped_at,refund_state';

  const [byId, byTrk] = await Promise.all([
    byOrderNumber.size
      ? supabase.from('orders').select(cols).in('razorpay_order_id', [...byOrderNumber.keys()])
      : Promise.resolve({ data: [] }),
    byAwb.size
      ? supabase.from('orders').select(cols).in('tracking_id', [...byAwb.keys()])
      : Promise.resolve({ data: [] }),
  ]);
  if (byId.error || byTrk.error) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: (byId.error || byTrk.error).message }) };
  }

  const seen = new Set();
  const orders = [];
  for (const o of [...(byId.data || []), ...(byTrk.data || [])]) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    if (SETTLED.includes(String(o.status || '').toLowerCase())) continue;

    const row = byOrderNumber.get(String(o.razorpay_order_id || '').toUpperCase())
      || byAwb.get(String(o.tracking_id || ''));
    const repl = isReplacement(o);
    const prepaid = !!o.razorpay_payment_id;
    const amount = Number(o.amount_paise || 0) / 100;
    const advance = Number(o.advance_paid_paise || 0) / 100;
    // A free replacement has no customer money in it, so nothing is refundable
    // however it was paid for. Otherwise: the full amount if it was prepaid,
    // the advance if it was a partial-COD, and nothing for plain COD.
    const refundDue = repl ? 0 : (prepaid ? amount : (advance > 0 ? advance : 0));

    orders.push({
      id: o.id,
      order_id: o.razorpay_order_id,
      awb: o.tracking_id || awbFromRow(row) || '',
      courier: o.courier_name || '',
      status: o.status,
      nimbus_status: shipmentStatusFromRow(row) || 'Cancelled',
      customer_name: o.customer_name || '',
      customer_phone: o.customer_phone || '',
      customer_email: o.customer_email || '',
      created_at: o.created_at,
      shipped_at: o.shipped_at,
      amount_inr: amount,
      advance_inr: advance,
      payment: repl ? 'Replacement' : (prepaid ? (String(o.razorpay_payment_id).startsWith('pay_') ? 'Razorpay' : 'PhonePe') : 'COD'),
      prepaid,
      is_replacement: repl,
      refund_due_inr: refundDue,
      items: cartOf(o).map(i => ({ title: i.title || i.name || '', qty: Number(i.qty) || 1 })),
    });
  }

  orders.sort((a, b) => b.refund_due_inr - a.refund_due_inr || String(b.created_at).localeCompare(String(a.created_at)));

  const totals = {
    orders: orders.length,
    order_value_inr: round2(orders.reduce((s, o) => s + o.amount_inr, 0)),
    refund_due_inr: round2(orders.reduce((s, o) => s + o.refund_due_inr, 0)),
    prepaid_orders: orders.filter(o => o.prepaid && !o.is_replacement).length,
    cod_orders: orders.filter(o => !o.prepaid && !o.is_replacement).length,
    replacements: orders.filter(o => o.is_replacement).length,
  };

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      pages,
      scanned: rows.length,
      cancelled_at_nimbus: cancelled.length,
      matched: seen.size,
      orders,
      totals,
    }),
  };
};

function round2(n) { return Math.round(n * 100) / 100; }
function emptyTotals() {
  return { orders: 0, order_value_inr: 0, refund_due_inr: 0, prepaid_orders: 0, cod_orders: 0, replacements: 0 };
}
