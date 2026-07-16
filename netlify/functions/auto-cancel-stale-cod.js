/**
 * Netlify scheduled function: cancel pure-COD shipments whose AWB has shown no
 * physical movement for seven full days. Prepaid and partial-COD orders are
 * fail-closed and never eligible.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { cancelNimbusShipment, inspectNimbusOrder } = require('./utils/nimbuspost-cancel');
const { notifyOrderCancelled } = require('./utils/order-cancelled-notification');
const { isDefinitelyCod } = require('./utils/order-payment-kind');
const { sendEmail } = require('./utils/email');
const { sendText } = require('./utils/whatsapp');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

const THRESHOLD_DAYS = 7;
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
      <p>The stale COD order <strong>${displayId(order)}</strong> is eligible for automatic cancellation, but NimbusPost did not accept the cancellation.</p>
      <p><strong>AWB:</strong> ${order.tracking_id || '-'}<br><strong>Error:</strong> ${String(error || 'Unknown error')}</p>
      <p>The admin order was left unchanged so it can be retried automatically. Please cancel the AWB manually if it is still visible in NimbusPost.</p>
    </div>`,
  }).catch(e => console.error('[stale-cod] owner failure email:', e.message));
}

async function runSweep(supabase, { dryRun = false } = {}) {
  const cutoff = new Date(Date.now() - THRESHOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const summary = {
    candidates: 0,
    eligible_cod: 0,
    cancelled: 0,
    skipped_not_cod: 0,
    skipped_moved: 0,
    skipped_unverified: 0,
    skipped_race: 0,
    nimbuspost_failed: 0,
    db_failed: 0,
    examples: [],
  };

  const { data: orders, error } = await supabase
    .from('orders')
    .select('*')
    .or('source.is.null,source.neq.paperbound')
    .eq('status', 'shipped')
    .not('tracking_id', 'is', null)
    .not('awb_assigned_at', 'is', null)
    .lte('awb_assigned_at', cutoff)
    .is('shipment_moved_at', null)
    .is('auto_cancelled_at', null)
    .is('auto_cancel_claimed_at', null)
    .order('awb_assigned_at', { ascending: true })
    .limit(MAX_PER_RUN);
  if (error) throw new Error(`Candidate query failed (run sql/orders_cod_auto_cancel.sql first): ${error.message}`);

  summary.candidates = orders?.length || 0;
  for (const order of orders || []) {
    if (!isDefinitelyCod(order)) {
      summary.skipped_not_cod++;
      continue;
    }
    summary.eligible_cod++;
    if (dryRun) {
      if (summary.examples.length < 10) summary.examples.push({ order_id: displayId(order), awb: order.tracking_id });
      continue;
    }

    // Webhooks can occasionally be delayed. Confirm the current panel state
    // before cancelling so a genuinely picked-up parcel is never cancelled.
    const inspection = await inspectNimbusOrder(displayId(order));
    if (inspection.moved) {
      summary.skipped_moved++;
      await supabase.from('orders').update({
        shipment_moved_at: new Date().toISOString(),
        last_nimbuspost_status: inspection.status || 'movement confirmed by panel',
        last_nimbuspost_event_at: new Date().toISOString(),
      }).eq('id', order.id);
      continue;
    }
    if (!inspection.ok || !inspection.found || !inspection.prePickup) {
      summary.skipped_unverified++;
      const verifyError = `Live NimbusPost state could not be verified as pre-pickup: ${inspection.status || inspection.error || 'unknown status'}`;
      await notifyCancellationFailure(order, verifyError);
      await supabase.from('orders').update({
        auto_cancel_last_error_at: new Date().toISOString(),
        auto_cancel_last_error: verifyError.slice(0, 1000),
      }).eq('id', order.id);
      continue;
    }

    const claimedAt = new Date().toISOString();
    const claim = await supabase
      .from('orders')
      .update({ auto_cancel_claimed_at: claimedAt })
      .eq('id', order.id)
      .eq('status', 'shipped')
      .is('shipment_moved_at', null)
      .is('auto_cancel_claimed_at', null)
      .select('id');
    if (claim.error || !claim.data?.length) {
      summary.skipped_race++;
      continue;
    }

    const np = await cancelNimbusShipment(order.tracking_id);
    if (!np.ok) {
      summary.nimbuspost_failed++;
      await notifyCancellationFailure(order, np.error);
      await supabase.from('orders').update({
        auto_cancel_claimed_at: null,
        auto_cancel_last_error_at: new Date().toISOString(),
        auto_cancel_last_error: String(np.error || 'NimbusPost cancellation failed').slice(0, 1000),
      }).eq('id', order.id);
      continue;
    }

    const cancelledAt = new Date().toISOString();
    const update = await supabase.from('orders').update({
      status: 'cancelled',
      auto_cancel_claimed_at: null,
      auto_cancelled_at: cancelledAt,
      cancellation_source: 'stale_cod_7_day',
      cancellation_reason: CUSTOMER_REASON,
      auto_cancel_last_error: null,
    }).eq('id', order.id);
    if (update.error) {
      summary.db_failed++;
      await notifyCancellationFailure(order, `NimbusPost was cancelled, but admin update failed: ${update.error.message}`);
      await supabase.from('orders').update({
        auto_cancel_claimed_at: null,
        auto_cancel_last_error_at: new Date().toISOString(),
        auto_cancel_last_error: `Admin update failed after NimbusPost cancellation: ${update.error.message}`.slice(0, 1000),
      }).eq('id', order.id);
      continue;
    }

    const cancelledOrder = { ...order, status: 'cancelled', auto_cancelled_at: cancelledAt };
    await notifyOrderCancelled(cancelledOrder, { reason: CUSTOMER_REASON, skipRefund: true });
    if (order.customer_phone) {
      await sendText(order.customer_phone, `Your Ink & Chai order ${displayId(order)} was cancelled because the book was out of stock with us. We are sorry for the inconvenience.`);
    }
    summary.cancelled++;
    if (summary.examples.length < 10) summary.examples.push({ order_id: displayId(order), awb: order.tracking_id });
  }

  return summary;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  let dryRun = false;
  if (event.httpMethod === 'POST') {
    const adminBlock = requireAdmin(event, CORS);
    if (adminBlock) return adminBlock;
    try { dryRun = !!JSON.parse(event.body || '{}').dry_run; } catch {}
  } else if (event.httpMethod) {
    // Netlify's scheduler invokes without an HTTP method. Reject ordinary URL
    // requests so a public GET can never start a cancellation sweep.
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const summary = await runSweep(supabase, { dryRun });
    console.log('[stale-cod]', JSON.stringify(summary));
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, dry_run: dryRun, summary }) };
  } catch (error) {
    console.error('[stale-cod] sweep failed:', error.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
  }
};

exports._runSweep = runSweep;
