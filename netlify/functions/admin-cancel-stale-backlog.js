/**
 * One-off drain for orders stranded PAST the sweep's age ceiling.
 *
 * auto-cancel-stale-cod refuses to act on an order older than
 * CANCEL_NO_AWB_MAX_AGE_DAYS so that an hourly job can never start messaging
 * customers about months of history it slept through. That leaves a pile
 * behind — 65 COD orders, oldest 93 days, when this was written — and this is
 * the deliberate, human-triggered way to clear it.
 *
 * DIFFERENT FROM THE SWEEP IN THREE WAYS, ALL ON PURPOSE:
 *
 *   1. SILENT. No email, no WhatsApp. The whole reason these are not in the
 *      sweep is that nobody wants to tell someone their June order is out of
 *      stock in September. Cancelling the record is housekeeping; messaging
 *      them is a decision, and it is not this function's to make.
 *
 *   2. NO COURIER CALL. These were pushed to a courier we have since left, and
 *      none of them ever got an AWB. Asking NimbusPost to cancel a
 *      three-month-old order it never booked achieves nothing except a failure
 *      email per order.
 *
 *   3. REFUSES MONEY BY DEFAULT. An order with a captured payment is skipped
 *      and listed, never cancelled. Cancelling a prepaid order silently means
 *      keeping the customer's money and not telling them — so a refund is
 *      always a separate, deliberate act.
 *
 * Dry run is the DEFAULT. A real run needs `confirm: true` explicitly.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { isDefinitelyCod } = require('./utils/order-payment-kind');
const { CANCEL_NO_AWB_MAX_AGE_DAYS, orderAgeDays } = require('./utils/cancellation-guard');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

const COD_STATUSES = ['cod_pending', 'cod_awaiting_confirmation'];
const HARD_CAP = 500;
const CANCEL_REASON = 'Order was never shipped and has been closed. No payment was taken.';

function displayId(o) { return o.razorpay_order_id || o.id; }

async function drain(supabase, { dryRun = true, limit = HARD_CAP, maxAgeDays = CANCEL_NO_AWB_MAX_AGE_DAYS } = {}) {
  const ceiling = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const out = {
    dry_run: dryRun,
    ceiling_days: maxAgeDays,
    candidates: 0,
    cancelled: 0,
    skipped_has_payment: 0,
    skipped_not_cod: 0,
    failed: 0,
    value_paise: 0,
    orders: [],
    needs_a_refund_decision: [],
  };

  const { data, error } = await supabase
    .from('orders')
    .select('id, razorpay_order_id, status, amount_paise, created_at, customer_name, razorpay_payment_id, shipment_payment_type, cart_items, tracking_id')
    .or('source.is.null,source.neq.paperbound')
    .in('status', COD_STATUSES)
    .is('tracking_id', null)
    .lt('created_at', ceiling)
    .is('auto_cancelled_at', null)
    .order('created_at', { ascending: true })
    .limit(Math.min(limit, HARD_CAP));
  if (error) throw new Error(`backlog query failed: ${error.message}`);

  out.candidates = data?.length || 0;
  for (const order of data || []) {
    // Money present. Never silently close an order somebody has paid for.
    if (String(order.razorpay_payment_id || '').trim() && Number(order.amount_paise) > 0) {
      out.skipped_has_payment++;
      out.needs_a_refund_decision.push({
        order_id: displayId(order), amount_paise: order.amount_paise,
        age_days: Number((orderAgeDays(order) || 0).toFixed(1)),
      });
      continue;
    }
    if (!isDefinitelyCod(order)) { out.skipped_not_cod++; continue; }

    const row = {
      order_id: displayId(order), amount_paise: order.amount_paise || 0,
      age_days: Number((orderAgeDays(order) || 0).toFixed(1)), customer: order.customer_name,
    };
    if (dryRun) { out.orders.push(row); out.value_paise += order.amount_paise || 0; continue; }

    const cancelledAt = new Date().toISOString();
    const { data: saved, error: updErr } = await supabase.from('orders').update({
      status: 'cancelled',
      auto_cancelled_at: cancelledAt,
      cancellation_source: 'stale_backlog_drain',
      cancellation_reason: CANCEL_REASON,
    })
      .eq('id', order.id)
      .in('status', COD_STATUSES)
      .is('tracking_id', null)
      .select('id');
    if (updErr || !saved?.length) { out.failed++; row.error = updErr?.message || 'row changed under us'; out.orders.push(row); continue; }
    out.cancelled++;
    out.value_paise += order.amount_paise || 0;
    out.orders.push(row);
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const adminBlock = requireAdmin(event, CORS);
  if (adminBlock) return adminBlock;

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  // Default is a dry run. Cancelling in bulk has to be asked for in words.
  const dryRun = body.confirm !== true;

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const result = await drain(supabase, {
      dryRun,
      limit: Number(body.limit) > 0 ? Number(body.limit) : HARD_CAP,
      maxAgeDays: Number(body.max_age_days) > 0 ? Number(body.max_age_days) : CANCEL_NO_AWB_MAX_AGE_DAYS,
    });
    console.log('[backlog-drain]', JSON.stringify({ ...result, orders: result.orders.length }));
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, ...result }) };
  } catch (err) {
    console.error('[backlog-drain] failed:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

exports.__test = { drain, COD_STATUSES, HARD_CAP, CANCEL_REASON };
