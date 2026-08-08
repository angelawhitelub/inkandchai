/**
 * Netlify Background Function: phonepe-retry-refunds
 * POST /.netlify/functions/phonepe-retry-refunds-background
 *
 * Fetches the real refund status from PhonePe for every order that is owed a
 * refund but not yet confirmed refunded, and:
 *   - COMPLETED  → marks the order 'refunded' (+ emails the customer)
 *   - PENDING    → leaves it (PhonePe still processing)
 *   - FAILED/none→ RE-ISSUES the refund with a fresh merchantRefundId
 *
 * Why: PhonePe fails a refund if, on a given settlement date, the refund amount
 * exceeds the payments the merchant received that day (balance policy). The
 * nightly batch of auto-cancelled (10-day-no-pickup) orders trips this. Once new
 * payments settle, a re-attempt succeeds — so this runs on a schedule and can be
 * triggered from the admin panel.
 *
 * MONEY-SAFE: it NEVER re-issues without first confirming (via the stored
 * refund_id status, or the order-status API) that no refund is already
 * completed or pending — so a customer is never double-refunded.
 *
 * Invoked by phonepe-retry-refunds-scheduled hourly through the afternoon IST
 * (1–6 PM), when the day's received payments are highest and PhonePe's
 * balance policy will actually let a re-attempt clear. Admin can POST to
 * trigger on demand. Scheduling stays separate because Netlify scheduled and
 * background functions use different invocation modes.
 */

const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('./utils/email');
const { requireAdmin } = require('./utils/admin-auth');
const { sendRefundInitiated } = require('./utils/refund-notifications');
const { neverCapturedPayment, NEVER_CAPTURED_ERROR, PAYMENT_FAILED_REASON } = require('./utils/payment-failed');
const { refundIdForAttempt, knownRefundIds } = require('./utils/refund-id');
const {
  getRefundStatus, getOrderStatus, refundStateFromOrder, issueRefund,
} = require('./utils/phonepe-core');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-Admin-Key',
  'Content-Type': 'application/json',
};

// Order states that mean "PhonePe money is still with us and a refund is owed".
const OWED_STATUSES = ['refund_pending', 'refund_failed', 'cancelled', 'rto', 'undelivered', 'lost'];
const MAX_ATTEMPTS = 10;   // stop hammering a genuinely un-refundable order

function isPhonePePayment(pid) {
  const p = String(pid || '');
  return p && !p.startsWith('pay_');   // OM…/T… = PhonePe; pay_… = Razorpay
}

function refundEmailHtml(order, amtPaise) {
  const amt = `₹${(amtPaise / 100).toLocaleString('en-IN')}`;
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#2a2018;background:#faf7f2;">
    <h2 style="font-family:Georgia,serif;font-weight:400;color:#8a6a1f;margin:0 0 12px;">Ink &amp; Chai</h2>
    <p>Hi ${(order.customer_name || 'there').split(' ')[0]},</p>
    <p>Your refund of <strong>${amt}</strong> for order <strong>${order.razorpay_order_id || order.id}</strong> has been processed via PhonePe and will appear in your original payment method within <strong>5–7 business days</strong>.</p>
    <p style="font-size:12px;color:#8a7a62;margin-top:24px;">Ink &amp; Chai · inkandchai.in</p>
  </div>`;
}

async function processOrder(supabase, order, force = false, reconcileOnly = false) {
  const displayId = order.razorpay_order_id || order.id;
  const amountPaise = Number(order.amount_paise) || 0;
  if (amountPaise <= 0) return { order: displayId, result: 'skip_no_amount' };

  // ── 1. Establish the TRUE current refund state (money-safe guard) ──────────
  // Check EVERY merchant refund id this order could have used, not just the one
  // currently stored. Retries used to mint a throwaway `-<epoch>` id and
  // overwrite refund_id, so a refund that had already COMPLETED under an earlier
  // id became invisible: the stored id answers REFUND_TRANSACTION_NOT_FOUND and
  // the order-status payload carries no refund fields at all. A single COMPLETED
  // anywhere in this list means the money is already back — stop.
  let trueState = null;                       // COMPLETED | PENDING | FAILED | null
  let gatewayRef = order.phonepe_refund_id || null;  // PhonePe's own refundId
  let matchedRefundId = null;
  for (const rid of knownRefundIds(order)) {
    let s;
    try { s = await getRefundStatus(rid); } catch (e) { continue; }
    const st = s.state || s.data?.state || null;
    if (!st) continue;                        // 400 / not found — id never landed
    if (s.data?.refundId) gatewayRef = s.data.refundId;
    matchedRefundId = rid;
    trueState = st;
    if (st === 'COMPLETED') break;            // authoritative, look no further
  }
  if (!trueState) {
    // Nothing found by id — ask the order API. (PhonePe does not currently
    // return refund details there, so this rarely helps; kept as a fallback in
    // case the payload gains them.)
    try {
      const os = await getOrderStatus(displayId);
      if (os.ok) trueState = refundStateFromOrder(os.data);
    } catch (e) { /* trueState stays null */ }
  }

  // ── 2. Act on the confirmed state ─────────────────────────────────────────
  if (trueState === 'COMPLETED') {
    const done = { status: 'refunded', refund_state: 'COMPLETED', refund_updated_at: new Date().toISOString() };
    if (gatewayRef) done.phonepe_refund_id = gatewayRef;
    // Point refund_id at the id that actually completed, so the record stops
    // naming an attempt PhonePe never accepted.
    if (matchedRefundId && matchedRefundId !== order.refund_id) done.refund_id = matchedRefundId;
    const { error: dErr } = await supabase.from('orders').update(done).eq('id', order.id);
    if (dErr && /phonepe_refund_id/i.test(dErr.message || '')) {
      const { phonepe_refund_id, ...noRef } = done;
      await supabase.from('orders').update(noRef).eq('id', order.id);
    }
    // The refund has ACTUALLY completed — safe to notify the customer now.
    // sendRefundInitiated is dedup-guarded (refund_notified_at) and gated on the
    // COMPLETED state, so this fires exactly once and never for a pending/failed refund.
    if (order.refund_state !== 'COMPLETED') {
      await sendRefundInitiated(order, amountPaise, { supabase, state: 'COMPLETED', refundRef: gatewayRef })
        .catch(e => console.error('reconcile refund-initiated notify:', e.message));
    }
    return { order: displayId, result: 'reconciled_completed' };
  }
  if (trueState === 'PENDING') {
    await supabase.from('orders').update({ refund_state: 'PENDING', refund_updated_at: new Date().toISOString() }).eq('id', order.id);
    return { order: displayId, result: 'still_pending' };
  }

  // trueState is FAILED or null (no refund exists / all failed) → safe to re-issue.
  // The trueState guard above still ran, so an admin-forced retry can never
  // double-refund — it only lifts the 10-attempt anti-spam cap.
  //
  // Reconcile-only runs stop here: they exist to flip PENDING→refunded promptly
  // (a refund that completes at 1 AM shouldn't wait for the 1–6 PM re-issue
  // window before the customer is told). Re-issuing must stay in that window —
  // PhonePe's balance policy makes off-window attempts fail, and every attempt
  // burns the MAX_ATTEMPTS cap.
  if (reconcileOnly) return { order: displayId, result: 'reconcile_only' };

  const attempts = Number(order.refund_attempts) || 0;
  if (!force && attempts >= MAX_ATTEMPTS) return { order: displayId, result: 'max_attempts' };

  // Derived from the attempt number, not the clock, so this id stays findable:
  // the next run reconstructs it from refund_attempts and can see how it went.
  const merchantRefundId = refundIdForAttempt(displayId, attempts);
  let res;
  try {
    res = await issueRefund({ merchantRefundId, originalMerchantOrderId: displayId, amountPaise });
  } catch (e) {
    await supabase.from('orders').update({
      status: 'refund_failed', refund_state: 'FAILED', refund_id: merchantRefundId,
      refund_attempts: attempts + 1, refund_last_error: String(e.message).slice(0, 300),
      refund_updated_at: new Date().toISOString(),
    }).eq('id', order.id);
    return { order: displayId, result: 'retry_error', error: e.message };
  }

  const st = res.state;
  if (res.ok && st && st !== 'FAILED') {
    // Accepted (PENDING/COMPLETED). Persist the new refund id so the next run
    // can check it precisely, and reflect status.
    const newStatus = st === 'COMPLETED' ? 'refunded' : 'refund_pending';
    await supabase.from('orders').update({
      status: newStatus, refund_id: merchantRefundId, refund_state: st,
      refund_attempts: attempts + 1, refund_last_error: null,
      refund_updated_at: new Date().toISOString(),
    }).eq('id', order.id);
    // Notify ONLY when PhonePe confirms the refund COMPLETED. A re-issued refund
    // usually comes back PENDING and can still fail asynchronously (balance
    // policy) — so PENDING must not trigger any customer message. A later run
    // will detect COMPLETED (above) and notify then. Dedup-guarded internally.
    if (newStatus === 'refunded') {
      await sendRefundInitiated(order, amountPaise, { supabase, state: st })
        .catch(e => console.error('retry refund-initiated notify:', e.message));
    }
    return { order: displayId, result: st === 'COMPLETED' ? 'retried_completed' : 'retried_pending' };
  }

  // Still failing (balance likely still short) — record and leave for next run.
  const errMsg = res.data?.message || res.data?.error || res.data?.code || `HTTP ${res.status}`;

  // …unless PhonePe says the original payment never completed. That is
  // permanent: this order took no money, so it owes no refund. Mark it as a
  // failed-payment cancellation and let it fall out of the sweep for good
  // instead of coming back every run until the attempt cap.
  if (NEVER_CAPTURED_ERROR.test(String(errMsg))) {
    await supabase.from('orders').update({
      status: 'cancelled', refund_state: null, refund_id: null,
      cancellation_reason: PAYMENT_FAILED_REASON,
      refund_attempts: attempts + 1, refund_last_error: String(errMsg).slice(0, 300),
      refund_updated_at: new Date().toISOString(),
    }).eq('id', order.id);
    console.log(`[phonepe-retry-refunds] ${displayId} never captured — closed, not owed`);
    return { order: displayId, result: 'never_captured' };
  }

  await supabase.from('orders').update({
    status: 'refund_failed', refund_state: 'FAILED', refund_id: merchantRefundId,
    refund_attempts: attempts + 1, refund_last_error: String(errMsg).slice(0, 300),
    refund_updated_at: new Date().toISOString(),
  }).eq('id', order.id);
  return { order: displayId, result: 'retry_failed', error: errMsg };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const block = requireAdmin(event, CORS); if (block) return block;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase env vars missing' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Admin can force a specific set of orders (bypasses the 10-attempt cap) via
  // { order_ids: ["IC-…"], force: true }. Scheduled runs pass neither.
  let reqBody = {};
  try { reqBody = JSON.parse(event.body || '{}'); } catch { /* scheduled = empty body */ }
  const forceOrderIds = Array.isArray(reqBody.order_ids)
    ? reqBody.order_ids.map(s => String(s).trim()).filter(Boolean).slice(0, 100)
    : null;
  const force = reqBody.force === true || reqBody.force === 'true';
  // Read-only mode: sync refund state from PhonePe (and notify on COMPLETED)
  // without ever re-issuing. Safe to run at any hour.
  const reconcileOnly = reqBody.reconcile_only === true || reqBody.reconcile_only === 'true';

  try {
    let query = supabase
      .from('orders')
      .select('*')
      .in('status', OWED_STATUSES)
      .order('created_at', { ascending: false })
      .limit(500);
    // Targeted force-retry: restrict to the requested order ids.
    if (forceOrderIds && forceOrderIds.length) query = query.in('razorpay_order_id', forceOrderIds);
    const { data: rows, error } = await query;
    if (error) throw error;

    // Only PhonePe-paid orders (Razorpay refunds go through the Razorpay path)
    // that actually took money. An order pre-inserted at checkout whose payment
    // then FAILED is also 'cancelled' with a PhonePe-shaped txn id, and used to
    // be swept in here and submitted for refund on every run — PhonePe rejects
    // it with "Order not in completed state" every time. Nothing is owed on a
    // payment that never completed, so it must never enter the retry loop, not
    // even under `force`.
    const candidates = (rows || [])
      .filter(o => isPhonePePayment(o.razorpay_payment_id))
      .filter(o => !neverCapturedPayment(o));

      const summary = { scanned: candidates.length, skipped_never_captured: (rows || []).filter(o => isPhonePePayment(o.razorpay_payment_id) && neverCapturedPayment(o)).length, reconciled_completed: 0, retried_completed: 0, retried_pending: 0, retry_failed: 0, retry_error: 0, still_pending: 0, max_attempts: 0, skip_no_amount: 0, reconcile_only: 0, never_captured: 0 };
    const details = [];
    for (const order of candidates) {
      let r;
      try { r = await processOrder(supabase, order, force, reconcileOnly); }
      catch (e) { r = { order: order.razorpay_order_id || order.id, result: 'error', error: e.message }; }
      if (summary[r.result] != null) summary[r.result]++;
      details.push(r);
      await new Promise(res => setTimeout(res, 120)); // gentle pacing vs PhonePe
    }

    console.log('[phonepe-retry-refunds] summary', JSON.stringify(summary));
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, summary, details }) };
  } catch (err) {
    console.error('[phonepe-retry-refunds] fatal:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
