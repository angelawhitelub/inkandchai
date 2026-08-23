/**
 * Pure-COD seven-day cancellation sweep for orders that never received an AWB.
 * Once an AWB exists, lack of courier movement must never auto-cancel an order.
 * Prepaid and partial-COD orders are fail-closed and never eligible.
 */

const { requireAdmin } = require('./utils/admin-auth');
const { cancelNimbusOrder } = require('./utils/nimbuspost-cancel');
const { notifyOrderCancelled } = require('./utils/order-cancelled-notification');
const { isDefinitelyCod } = require('./utils/order-payment-kind');
const { cancellationAllowed, CANCEL_MIN_AGE_DAYS } = require('./utils/cancellation-guard');
const { sendEmail } = require('./utils/email');
const { sendText } = require('./utils/whatsapp');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

// Was 7, which cancelled orders three days inside the protected window. The
// threshold is now the guard itself, so this job and the courier sync can never
// drift apart: raising one raises both.
const THRESHOLD_DAYS = CANCEL_MIN_AGE_DAYS;
const MAX_PER_RUN = 25;
const CUSTOMER_REASON = 'The book in your order was out of stock with us, so we had to cancel your order. We are sorry for the inconvenience.';

function displayId(order) {
  return order.razorpay_order_id || order.id;
}

async function notifyCancellationFailure(order, error) {
  const owner = process.env.STORE_OWNER_EMAIL;
  if (!owner) return;
  const previous = order.auto_cancel_last_error_at ? new Date(order.auto_cancel_last_error_at).getTime() : 0;
  if (previous && Date.now() - previous < 24 * 60 * 60 * 1000) return;
  await sendEmail({
    to: owner,
    subject: `URGENT: NimbusPost cancellation failed - ${displayId(order)}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;">
      <h2 style="color:#b42318;">NimbusPost cancellation needs attention</h2>
      <p>The COD order <strong>${displayId(order)}</strong> is eligible for automatic cancellation, but NimbusPost did not accept the cancellation.</p>
      <p><strong>AWB:</strong> ${order.tracking_id || '-'}<br><strong>Error:</strong> ${String(error || 'Unknown error')}</p>
      <p>The admin order was left unchanged so it can be retried automatically. Please cancel the AWB manually if it is still visible in NimbusPost.</p>
    </div>`,
  }).catch(e => console.error('[stale-cod] owner failure email:', e.message));
}

async function runSweep(supabase, { dryRun = false } = {}) {
  const cutoff = new Date(Date.now() - THRESHOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const summary = {
    no_awb_candidates: 0,
    no_awb_eligible_cod: 0,
    no_awb_cancelled: 0,
    no_awb_skipped_not_cod: 0,
    no_awb_skipped_recent_push: 0,
    no_awb_skipped_race: 0,
    no_awb_nimbuspost_failed: 0,
    no_awb_db_failed: 0,
    examples: [],
  };

  // Path 1: pure-COD orders that still have no AWB after seven full days.
  // `created_at` is the fallback clock; if the order was pushed to NimbusPost
  // later, give it a fresh seven-day window from `nimbus_pushed_at`.
  const { data: noAwbOrders, error: noAwbError } = await supabase
    .from('orders')
    .select('*')
    .or('source.is.null,source.neq.paperbound')
    .in('status', ['cod_pending', 'cod_awaiting_confirmation'])
    .is('tracking_id', null)
    .lte('created_at', cutoff)
    .is('auto_cancelled_at', null)
    .is('auto_cancel_claimed_at', null)
    .order('created_at', { ascending: true })
    .limit(MAX_PER_RUN);
  if (noAwbError) throw new Error(`No-AWB candidate query failed (run sql/orders_cod_auto_cancel.sql first): ${noAwbError.message}`);

  summary.no_awb_candidates = noAwbOrders?.length || 0;
  for (const order of noAwbOrders || []) {
    if (!isDefinitelyCod(order)) {
      summary.no_awb_skipped_not_cod++;
      continue;
    }
    const waitStartedAt = new Date(order.nimbus_pushed_at || order.created_at).getTime();
    if (!Number.isFinite(waitStartedAt) || waitStartedAt > new Date(cutoff).getTime()) {
      summary.no_awb_skipped_recent_push++;
      continue;
    }
    summary.no_awb_eligible_cod++;
    if (dryRun) {
      if (summary.examples.length < 10) summary.examples.push({ order_id: displayId(order), awb: null, type: 'no_awb' });
      continue;
    }

    const claimedAt = new Date().toISOString();
    const claim = await supabase
      .from('orders')
      .update({ auto_cancel_claimed_at: claimedAt })
      .eq('id', order.id)
      .in('status', ['cod_pending', 'cod_awaiting_confirmation'])
      .is('tracking_id', null)
      .is('auto_cancel_claimed_at', null)
      .select('id');
    if (claim.error || !claim.data?.length) {
      summary.no_awb_skipped_race++;
      continue;
    }

    // Confirmed panel pushes are cancelled upstream by NimbusPost's internal
    // order id. Orders never pushed (including unconfirmed high-value COD) have
    // nothing upstream to cancel.
    let np = { ok: true, notRequired: true };
    if (order.nimbus_pushed_at) np = await cancelNimbusOrder(displayId(order));
    if (!np.ok) {
      summary.no_awb_nimbuspost_failed++;
      await notifyCancellationFailure(order, np.error);
    }

    // Belt and braces: the cutoff above filters the QUERY, this checks the ROW.
    // A stale claim, a retry, or a future edit to the query could otherwise put
    // an order here that is younger than the guard allows.
    const verdict = cancellationAllowed(order);
    if (!verdict.allowed) {
      await supabase.from('orders').update({ auto_cancel_claimed_at: null }).eq('id', order.id);
      console.warn(`[stale-cod] BLOCKED cancel for ${displayId(order)}: ${verdict.reason} (min ${CANCEL_MIN_AGE_DAYS}d) — claim released`);
      summary.blocked_too_young = (summary.blocked_too_young || 0) + 1;
      continue;
    }

    const cancelledAt = new Date().toISOString();
    const npError = np.ok ? null : `NimbusPost panel cancellation failed: ${np.error || 'unknown error'}`.slice(0, 1000);
    const update = await supabase.from('orders').update({
      status: 'cancelled',
      auto_cancel_claimed_at: null,
      auto_cancelled_at: cancelledAt,
      // Stable identifier, not a duration: ~2,000 historical rows carry this
      // exact string and the admin badge filters on it. The actual threshold is
      // CANCEL_MIN_AGE_DAYS above — do not encode the number here again.
      cancellation_source: 'no_awb_cod_7_day',
      cancellation_reason: CUSTOMER_REASON,
      auto_cancel_last_error_at: np.ok ? null : cancelledAt,
      auto_cancel_last_error: npError,
    })
      .eq('id', order.id)
      .in('status', ['cod_pending', 'cod_awaiting_confirmation'])
      .is('tracking_id', null)
      .select('id');
    if (update.error || !update.data?.length) {
      summary.no_awb_db_failed++;
      await supabase.from('orders').update({ auto_cancel_claimed_at: null }).eq('id', order.id);
      continue;
    }

    const cancelledOrder = { ...order, status: 'cancelled', auto_cancelled_at: cancelledAt };
    await notifyOrderCancelled(cancelledOrder, { reason: CUSTOMER_REASON, skipRefund: true });
    if (order.customer_phone) {
      await sendText(order.customer_phone, `Your Ink & Chai order ${displayId(order)} was cancelled because the book was out of stock with us. We are sorry for the inconvenience.`);
    }
    summary.no_awb_cancelled++;
    if (summary.examples.length < 10) summary.examples.push({ order_id: displayId(order), awb: null, type: 'no_awb' });
  }

  return summary;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod === 'POST') {
    const adminBlock = requireAdmin(event, CORS);
    if (adminBlock) return adminBlock;
  } else if (event.httpMethod) {
    // Netlify's scheduler invokes without an HTTP method. Reject ordinary URL
    // requests so a public GET can never start a cancellation sweep.
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const secret = process.env.ADMIN_SECRET;
  const site = String(process.env.SITE_URL || process.env.URL || 'https://inkandchai.in').replace(/\/$/, '');
  if (!secret) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Scheduler auth not configured' }) };

  let body = '{}';
  if (event.httpMethod === 'POST') {
    try { body = JSON.stringify({ dry_run: !!JSON.parse(event.body || '{}').dry_run }); } catch {}
  }
  try {
    const response = await fetch(`${site}/.netlify/functions/auto-cancel-stale-cod-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': secret },
      body,
    });
    if (!response.ok && response.status !== 202) throw new Error(`worker enqueue returned ${response.status}`);
    console.log(`[stale-cod-scheduler] worker enqueued (${response.status})`);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ enqueued: true }) };
  } catch (error) {
    console.error('[stale-cod-scheduler] failed:', error.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
  }
};

exports._runSweep = runSweep;
