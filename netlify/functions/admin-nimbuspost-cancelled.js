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
const { trackNimbusShipments } = require('./utils/nimbuspost-cancel');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

// Already dealt with — cancelled, or somewhere in the refund pipeline. Listing
// these again would invite a second cancellation on an order that already has
// a refund in flight.
const SETTLED = [
  'cancelled', 'refunded', 'refund_pending', 'partially_refunded', 'refund_failed',
];

// Reached the customer (or the courier is still trying), so a NimbusPost
// "cancelled" against one of these is not an unreconciled auto-cancel.
const TERMINAL = ['delivered', 'returned', 'rto'];

// NimbusPost's own word for the shipment. Narrow on purpose: this drives a
// money action, so "cancellation requested" (a request) must not match.
function npSaysCancelled(status) {
  const s = String(status || '').trim();
  if (!s) return false;
  if (/cancellation\s+requested/i.test(s)) return false;
  return /\b(cancell?ed)\b/i.test(s);
}

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

  if (!process.env.NIMBUSPOST_EMAIL || !process.env.NIMBUSPOST_PASSWORD) {
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: 'NIMBUSPOST_EMAIL / NIMBUSPOST_PASSWORD not configured' }) };
  }

  // How many of our own open shipments to check, newest AWB first. This used to
  // page NimbusPost's panel newest-CREATED-first and look for cancelled rows,
  // which could not work: NimbusPost auto-cancels shipments nobody picked up,
  // so the ones we need are the OLDEST, hundreds of rows past any such window.
  // A sweep that reported "0 still open" while 37 auto-cancelled orders sat at
  // `shipped` is what that cost. Now the question runs the other way -- we hand
  // NimbusPost the AWBs of everything still open on our side and ask what it
  // thinks -- so age is irrelevant and only our open-order count bounds it.
  const pages = Math.min(Math.max(Number(event.queryStringParameters?.pages) || 5, 1), 25);
  const limit = pages * 100;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const cols = 'id,razorpay_order_id,razorpay_payment_id,tracking_id,courier_name,status,amount_paise,'
    + 'advance_paid_paise,customer_name,customer_phone,customer_email,cart_items,created_at,source,'
    + 'shipped_at,refund_state';

  // PostgREST caps a single response at 1000 rows regardless of .limit(), so
  // pull in pages -- asking for 1600 and silently getting 1000 would leave the
  // oldest open shipments unchecked, which are exactly the ones NimbusPost
  // auto-cancels.
  const PAGE = 1000;
  const candidates = [];
  for (let from = 0; from < limit; from += PAGE) {
    const to = Math.min(from + PAGE, limit) - 1;
    const { data, error } = await supabase
      .from('orders')
      .select(cols)
      .not('tracking_id', 'is', null)
      .neq('tracking_id', '')
      .not('status', 'in', `(${[...SETTLED, ...TERMINAL].join(',')})`)
      .order('awb_assigned_at', { ascending: false, nullsFirst: false })
      .range(from, to);
    if (error) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    }
    candidates.push(...(data || []));
    if (!data || data.length < to - from + 1) break;   // ran out of rows
  }
  if (!candidates.length) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, scanned: 0, pages, cancelled_at_nimbus: 0, matched: 0, orders: [], totals: emptyTotals() }),
    };
  }

  let tracked;
  try {
    tracked = await trackNimbusShipments(candidates.map(o => o.tracking_id));
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: `NimbusPost: ${e.message}` }) };
  }

  // Index the tracking rows both ways. order_number is our own IC-… id and is
  // the reliable key; the AWB covers anything pushed before we sent it.
  const npByOrder = new Map();
  const npByAwb = new Map();
  for (const row of tracked) {
    if (!npSaysCancelled(row?.status)) continue;
    const num = String(row?.order_number || '').trim().toUpperCase();
    const awb = String(row?.awb_number || '').trim();
    if (num) npByOrder.set(num, row);
    if (awb) npByAwb.set(awb, row);
  }

  const seen = new Set();
  const orders = [];
  for (const o of candidates) {
    const row = npByOrder.get(String(o.razorpay_order_id || '').trim().toUpperCase())
      || npByAwb.get(String(o.tracking_id || '').trim());
    if (!row) continue;                       // NimbusPost does not call it cancelled
    if (seen.has(o.id)) continue;
    seen.add(o.id);
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
      awb: o.tracking_id || row.awb_number || '',
      courier: o.courier_name || row.courier_name || '',
      status: o.status,
      nimbus_status: String(row.status || 'cancelled'),
      nimbus_event_time: row.event_time || '',
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
      scanned: candidates.length,
      cancelled_at_nimbus: seen.size,
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
