/**
 * Seven-day cancellation sweep for orders that never received an AWB.
 * Once an AWB exists, lack of courier movement must never auto-cancel an order.
 *
 * Two paths, because the money works differently:
 *   Path 1  pure COD      — cancel, nothing to refund.
 *   Path 2  prepaid and   — cancel AND return the money that was captured.
 *           partial COD
 *
 * Path 2 is newer and deliberately the more cautious of the two. It refuses
 * any order without a gateway payment reference rather than cancelling a
 * "paid" row it cannot actually refund, and it is capped far below Path 1 so a
 * bad query cannot empty the gateway balance in a single hourly run.
 */

const { requireAdmin } = require('./utils/admin-auth');
const { cancelNimbusOrder } = require('./utils/nimbuspost-cancel');
const { notifyOrderCancelled } = require('./utils/order-cancelled-notification');
const { isDefinitelyCod } = require('./utils/order-payment-kind');
const { cancellationAllowed, CANCEL_NO_AWB_MIN_AGE_DAYS } = require('./utils/cancellation-guard');
const { sendEmail } = require('./utils/email');
const { sendText } = require('./utils/whatsapp');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

// Seven days, from the guard, so this job and the guard cannot drift apart.
// This is the NO-AWB floor specifically, not the courier-cancellation floor —
// see cancellation-guard.js for why the two differ.
const THRESHOLD_DAYS = CANCEL_NO_AWB_MIN_AGE_DAYS;
const MAX_PER_RUN = 25;

// Prepaid cancellation moves real money, so it gets its own, much smaller cap.
// At the observed backlog (3 orders, Rs 582) this is never the binding limit;
// it exists so that a future query bug cannot issue 25 refunds an hour before
// anyone notices.
const MAX_REFUNDS_PER_RUN = 10;

// Kill switch. Set AUTO_CANCEL_STALE_PREPAID=0 to stop Path 2 without
// touching Path 1 or redeploying anything else.
function prepaidSweepEnabled(raw = process.env.AUTO_CANCEL_STALE_PREPAID) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (['0', 'off', 'false', 'no'].includes(v)) return false;
  return true;
}

const PREPAID_STATUSES = ['paid', 'confirmed', 'partial_cod_pending'];

const CUSTOMER_REASON = 'The book in your order was out of stock with us, so we had to cancel your order. We are sorry for the inconvenience.';
const PREPAID_CUSTOMER_REASON = 'The book in your order was out of stock with us, so we had to cancel your order and return your money. We are sorry for the inconvenience.';

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
    prepaid_candidates: 0,
    prepaid_eligible: 0,
    prepaid_cancelled: 0,
    prepaid_refund_requested: 0,
    prepaid_refund_confirmed: 0,
    prepaid_skipped_is_cod: 0,
    prepaid_skipped_no_payment_ref: 0,
    prepaid_skipped_race: 0,
    prepaid_skipped_too_young: 0,
    prepaid_db_failed: 0,
    prepaid_disabled: false,
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
    // minAgeDays is passed explicitly. Without it the guard applies its
    // 10-day courier default and would silently block every order this sweep
    // is now meant to catch between days 7 and 10.
    const verdict = cancellationAllowed(order, { minAgeDays: THRESHOLD_DAYS });
    if (!verdict.allowed) {
      await supabase.from('orders').update({ auto_cancel_claimed_at: null }).eq('id', order.id);
      console.warn(`[stale-cod] BLOCKED cancel for ${displayId(order)}: ${verdict.reason} (min ${THRESHOLD_DAYS}d) — claim released`);
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
      // THRESHOLD_DAYS above — do not encode the number here again.
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

  // ── Path 2: PREPAID and partial-COD orders with no AWB after seven days ───
  // Same trigger as Path 1, but money was captured, so cancelling without
  // returning it would be theft by timeout. The refund itself is delegated to
  // notifyOrderCancelled, which already owns every safeguard that matters:
  // it re-reads the row, refuses an order that is refunded / partially
  // refunded / refund_pending, refuses RTO, marks refund_pending BEFORE
  // calling the gateway so two events cannot both pay, and never tells the
  // customer the money is issued while the gateway still says pending.
  // Duplicating any of that here would be a second opinion about whether
  // someone has been paid, which is exactly how an order gets refunded twice.
  if (!prepaidSweepEnabled()) {
    summary.prepaid_disabled = true;
    return summary;
  }

  const { data: prepaidOrders, error: prepaidError } = await supabase
    .from('orders')
    .select('*')
    .or('source.is.null,source.neq.paperbound')
    .in('status', PREPAID_STATUSES)
    .is('tracking_id', null)
    .lte('created_at', cutoff)
    .is('auto_cancelled_at', null)
    .is('auto_cancel_claimed_at', null)
    .order('created_at', { ascending: true })
    .limit(MAX_REFUNDS_PER_RUN);
  if (prepaidError) throw new Error(`Prepaid candidate query failed: ${prepaidError.message}`);

  summary.prepaid_candidates = prepaidOrders?.length || 0;
  for (const order of prepaidOrders || []) {
    // A pure-COD row that somehow reached a prepaid status belongs to Path 1,
    // which knows not to promise a refund. Never let it fall through to here.
    if (isDefinitelyCod(order)) {
      summary.prepaid_skipped_is_cod++;
      continue;
    }
    // Fail closed on money. "Paid" with no gateway reference is a data problem,
    // and cancelling it would tell a customer their refund is on its way when
    // there is nothing to send it through. Leave it for a human.
    if (!String(order.razorpay_payment_id || '').trim() || !(Number(order.amount_paise) > 0)) {
      summary.prepaid_skipped_no_payment_ref++;
      console.warn(`[stale-cod] ${displayId(order)} is ${order.status} with no usable payment reference — left for manual review`);
      continue;
    }
    const verdict = cancellationAllowed(order, { minAgeDays: THRESHOLD_DAYS });
    if (!verdict.allowed) {
      summary.prepaid_skipped_too_young++;
      continue;
    }
    summary.prepaid_eligible++;
    if (dryRun) {
      if (summary.examples.length < 10) {
        summary.examples.push({
          order_id: displayId(order), awb: null, type: 'prepaid',
          refund_paise: order.amount_paise, age_days: Number(verdict.ageDays.toFixed(1)),
        });
      }
      continue;
    }

    const claimedAt = new Date().toISOString();
    const claim = await supabase
      .from('orders')
      .update({ auto_cancel_claimed_at: claimedAt })
      .eq('id', order.id)
      .in('status', PREPAID_STATUSES)
      .is('tracking_id', null)
      .is('auto_cancel_claimed_at', null)
      .select('id');
    if (claim.error || !claim.data?.length) {
      summary.prepaid_skipped_race++;
      continue;
    }

    // Status is NOT written here. notifyOrderCancelled moves a refunded order
    // to refund_pending / refunded itself, and stamping 'cancelled' on top of
    // that would erase where the money got to.
    const cancelledAt = new Date().toISOString();
    const update = await supabase.from('orders').update({
      auto_cancel_claimed_at: null,
      auto_cancelled_at: cancelledAt,
      cancellation_source: 'no_awb_prepaid_7_day',
      cancellation_reason: PREPAID_CUSTOMER_REASON,
    })
      .eq('id', order.id)
      .in('status', PREPAID_STATUSES)
      .is('tracking_id', null)
      .select('id');
    if (update.error || !update.data?.length) {
      summary.prepaid_db_failed++;
      await supabase.from('orders').update({ auto_cancel_claimed_at: null }).eq('id', order.id);
      continue;
    }
    summary.prepaid_cancelled++;
    summary.prepaid_refund_requested++;

    // No skipRefund: this is the whole point of Path 2.
    const result = await notifyOrderCancelled(
      { ...order, auto_cancelled_at: cancelledAt },
      { reason: PREPAID_CUSTOMER_REASON },
    );
    if (result?.refund?.ok && result.refund.nextStatus === 'refunded') summary.prepaid_refund_confirmed++;

    // Don't strand the order. maybeAutoRefund owns the status once it engages
    // (refund_pending -> refunded), but every one of its early exits -- no id,
    // already refunded, RTO, no payment reference, no amount -- returns before
    // touching it. Those are pre-filtered above, so reaching here with the
    // status untouched should be impossible; if it happens anyway the order
    // would sit in 'paid' carrying auto_cancelled_at, cancelled in every way
    // except the one the admin panel can see. Close it out as cancelled.
    const { data: after } = await supabase
      .from('orders').select('status').eq('id', order.id).maybeSingle();
    if (after && PREPAID_STATUSES.includes(after.status)) {
      console.warn(`[stale-cod] ${displayId(order)} refund did not claim the row (${JSON.stringify(result?.refund?.skipped || result?.refund?.error || null)}) — marking cancelled`);
      await supabase.from('orders').update({ status: 'cancelled' })
        .eq('id', order.id).in('status', PREPAID_STATUSES);
      summary.prepaid_refund_unclaimed = (summary.prepaid_refund_unclaimed || 0) + 1;
    }
    if (summary.examples.length < 10) {
      summary.examples.push({
        order_id: displayId(order), awb: null, type: 'prepaid',
        refund_paise: order.amount_paise, refund: result?.refund?.skipped || result?.refund?.nextStatus || 'requested',
      });
    }
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
exports.__test = {
  prepaidSweepEnabled, PREPAID_STATUSES, THRESHOLD_DAYS, MAX_PER_RUN, MAX_REFUNDS_PER_RUN,
  PREPAID_CUSTOMER_REASON,
};
