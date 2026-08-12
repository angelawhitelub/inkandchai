/**
 * Netlify Function: razorpay-refund
 * POST /.netlify/functions/razorpay-refund
 *
 * Admin endpoint — issues a refund (full or partial) against a captured RAZORPAY
 * payment (id starts with "pay_"). Mirrors phonepe-refund.js so the admin refund
 * modal can call either endpoint with the same request/response contract.
 *
 * Body: { order_id: "IC-…", amount_rupees? , amount_paise? }
 *   - no amount        → full refund
 *   - amount_rupees/paise → partial refund (Razorpay allows multiple partials)
 *
 * Money-safety: a Razorpay refund is committed the moment the API returns 2xx
 * (unlike PhonePe, it does not silently fail later on a merchant-balance policy).
 * So on success we mark the order refunded/partially_refunded and notify the
 * customer — matching the existing cancel-order.js Razorpay behaviour. A response
 * that comes back status='failed' is treated as a failure (no status change,
 * no notification).
 */

const { createClient } = require('@supabase/supabase-js');
const { issueRazorpayRefund } = require('./utils/razorpay-refund');
const { sendRefundInitiated, cleanRefundItems } = require('./utils/refund-notifications');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

// Same eligibility set as phonepe-refund.js.
const REFUNDABLE = ['paid', 'confirmed', 'shipped', 'out_for_delivery',
  'delivered', 'refund_pending', 'refund_failed', 'partially_refunded',
  'cancelled', 'rto', 'undelivered', 'lost'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS);
  if (_adminBlock) return _adminBlock;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const displayId = String(body.order_id || '').trim();
  if (!displayId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide order_id' }) };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data: order } = await supabase
      .from('orders').select('*').eq('razorpay_order_id', displayId).maybeSingle();

    if (!order) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: `Order not found: ${displayId}` }) };
    if (order.status === 'refunded') {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Order is already fully refunded.' }) };
    }
    if (!REFUNDABLE.includes(order.status)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Order status is '${order.status}' — not eligible for refund.` }) };
    }

    const paymentId = order.razorpay_payment_id || '';
    if (!paymentId.startsWith('pay_')) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'This order is not a Razorpay payment — use the PhonePe refund tool instead.' }) };
    }

    const orderAmount = order.amount_paise;
    if (!orderAmount || orderAmount <= 0) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Order has no captured amount to refund.' }) };
    }

    // Resolve refund amount (default = full).
    let amountPaise = orderAmount;
    if (body.amount_paise != null) amountPaise = Math.round(Number(body.amount_paise));
    else if (body.amount_rupees != null) amountPaise = Math.round(Number(body.amount_rupees) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid refund amount.' }) };
    }
    if (amountPaise > orderAmount) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Refund ₹${amountPaise / 100} exceeds order amount ₹${orderAmount / 100}.` }) };
    }
    const isFullRefund = amountPaise >= orderAmount;
    // Which books the admin ticked; only meaningful on a partial.
    const refundItems = isFullRefund ? [] : cleanRefundItems(body.refund_items);

    // Create the refund. issueRazorpayRefund throws on any non-2xx (e.g. amount
    // exceeds the remaining refundable balance — Razorpay validates that for us,
    // so we never over-refund even across multiple partials).
    let refund;
    try {
      refund = await issueRazorpayRefund(paymentId, isFullRefund ? 0 : amountPaise, {
        notes: { reason: 'Admin-issued refund', order_id: displayId },
      });
    } catch (err) {
      // Record the failure so it's visible; do NOT mark the order refunded.
      await supabase.from('orders').update({
        status: 'refund_failed',
        refund_last_error: String(err.message).slice(0, 300),
        refund_attempts: (Number(order.refund_attempts) || 0) + 1,
        refund_updated_at: new Date().toISOString(),
      }).eq('id', order.id).then(() => {}, () => {});
      throw err;
    }

    const rzpStatus = String(refund.status || '').toLowerCase(); // created | pending | processed | failed
    if (rzpStatus === 'failed') {
      await supabase.from('orders').update({
        status: 'refund_failed', refund_id: refund.id || null, refund_state: 'FAILED',
        refund_attempts: (Number(order.refund_attempts) || 0) + 1,
        refund_last_error: 'Razorpay returned status=failed',
        refund_updated_at: new Date().toISOString(),
      }).eq('id', order.id).then(() => {}, () => {});
      throw new Error('Razorpay rejected the refund (status=failed). Try again from the Razorpay dashboard.');
    }

    // 2xx + not-failed ⇒ committed. Mark refunded / partially_refunded.
    const nextStatus = isFullRefund ? 'refunded' : 'partially_refunded';
    const refundUpdate = {
      status: nextStatus,
      refund_id: refund.id || null,
      refund_state: (refund.status || 'processed').toUpperCase(),
      refund_updated_at: new Date().toISOString(),
    };
    if (refundItems.length) refundUpdate.refund_items = refundItems;
    {
      const { error } = await supabase.from('orders').update(refundUpdate).eq('id', order.id);
      // sql/refund_partial_notifications.sql may not have been run yet — the
      // refund itself is already committed at Razorpay, so never let a missing
      // column lose the status write.
      if (error && /refund_items/i.test(error.message || '')) {
        const { refund_items, ...withoutItems } = refundUpdate;
        await supabase.from('orders').update(withoutItems).eq('id', order.id);
        console.warn('[razorpay-refund] refund_items column missing — run sql/refund_partial_notifications.sql');
      }
    }

    // Notify the customer (+ owner) that the refund was issued. Razorpay callers
    // omit `state` — the refund is committed on creation, so this is the correct
    // "refund issued" moment (see utils/refund-notifications). Dedup-guarded by
    // refund_notified_at so a later re-run never double-notifies.
    // refundRef is Razorpay's own rfnd_… — the reference the customer quotes to
    // their bank. It was already being written to the row but never handed to
    // the notifier, so `order` (read before the refund existed) had no way to
    // supply it and every Razorpay refund message went out without a reference.
    await sendRefundInitiated(order, amountPaise, {
      supabase, items: refundItems, refundRef: refund.id || null,
    }).catch(e => console.error('refund-initiated notify:', e.message));

    const amtLabel = `₹${(amountPaise / 100).toLocaleString('en-IN')}`;
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        refund_id: refund.id || null,
        // Report COMPLETED so the shared admin modal marks the row refunded; the
        // money is committed at Razorpay even while the bank settlement is pending.
        state: 'COMPLETED',
        razorpay_status: rzpStatus || 'processed',
        amount: amtLabel,
        is_full: isFullRefund,
        message: `${isFullRefund ? 'Full refund' : 'Partial refund'} of ${amtLabel} issued via Razorpay. The customer has been notified; it settles in 5–7 business days.`,
      }),
    };
  } catch (err) {
    console.error('razorpay-refund error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
