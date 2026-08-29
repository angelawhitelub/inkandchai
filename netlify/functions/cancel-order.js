/**
 * Netlify Function: cancel-order
 * POST /.netlify/functions/cancel-order
 *
 * Unified customer-facing cancellation endpoint for both COD and prepaid orders.
 *
 * COD orders  (cod_pending / confirmed):
 *   → Marks as "cancelled". No refund needed.
 *
 * Partial COD orders (partial_cod_pending) within 30 minutes of creation:
 *   → Cancels only before shipment and refunds the captured deposit.
 *
 * Prepaid orders (status "paid") within 30 minutes of creation:
 *   → Issues full Razorpay refund (if razorpay_payment_id starts with "pay_").
 *   → For PhonePe / unknown IDs: marks as "refund_pending", emails admin.
 *   → Sends cancellation + refund confirmation email to customer.
 *
 * Security: validates JWT, confirms order ownership by email.
 */

const { createClient } = require('@supabase/supabase-js');

const { sendEmail } = require('./utils/email');
const { notifyOrderCancelled } = require('./utils/order-cancelled-notification');
const { issueRazorpayRefund } = require('./utils/razorpay-refund');
const { cancelNimbusShipment, cancelNimbusOrder } = require('./utils/nimbuspost-cancel');
const { npShipmentMoved, statusImpliesMovement } = require('./utils/nimbuspost-track');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const COD_CANCELLABLE   = ['cod_pending', 'partial_cod_pending', 'confirmed'];
const FINAL_STATUSES    = ['shipped', 'out_for_delivery', 'delivered', 'cancelled', 'refunded', 'refund_pending'];
const PREPAID_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

function isPartialCod(order) {
  if (String(order?.status || '').toLowerCase() === 'partial_cod_pending') return true;
  if (Number(order?.advance_paid_paise || 0) > 0) return true;
  if (String(order?.shipment_payment_type || '').toLowerCase() === 'partial_cod') return true;
  const items = Array.isArray(order?.cart_items) ? order.cart_items : [];
  return items.some(item => {
    const meta = item?._payment || item?.__payment || {};
    return String(meta.mode || meta.payment_type || '').toLowerCase() === 'partial_cod';
  });
}

function cancellationAge(order, now = Date.now()) {
  const createdAt = order?.created_at ? new Date(order.created_at).getTime() : 0;
  return {
    ageMs: createdAt ? now - createdAt : Number.POSITIVE_INFINITY,
    minutesAgo: createdAt ? Math.max(0, Math.floor((now - createdAt) / 60000)) : null,
  };
}

// An AWB can be assigned while a parcel is still sitting at the warehouse, so
// tracking_id alone must not block COD cancellation. NimbusPost webhook events
// stamp shipment_moved_at on the first pickup/in-transit scan. The raw-status
// fallback protects older rows and aliases while that timestamp is populated.
//
// This is a LOCAL read, and both columns are NULL until a webhook lands. The
// pattern lives in utils/nimbuspost-track.js now, which added "picked" — the
// status NimbusPost actually sends first, and the one this file's old pattern
// missed because it only listed "picked up". See npShipmentMoved() at the
// cancellation site for the check that does not depend on a webhook at all.
function shipmentHasMoved(order) {
  if (order?.shipment_moved_at) return true;
  return statusImpliesMovement(order?.last_nimbuspost_status);
}

// Has the customer's money actually been taken? Nothing captured means
// cancelling costs nobody anything — there is no refund to get wrong.
// advance_paid_paise > 0 is partial COD: the 10% deposit IS captured, so those
// stay on the manual request path where a refund can be handled deliberately.
function moneyCaptured(order) {
  return Boolean(order?.razorpay_payment_id)
    || Number(order?.advance_paid_paise || 0) > 0
    || String(order?.status || '').toLowerCase() === 'paid';
}

// status 'shipped' does NOT mean a courier has the parcel.
// nimbuspost-ship.js sets status='shipped' the moment an AWB is created from
// the panel — minutes after the order, with the packet still on the table.
// Actual courier movement is recorded separately, by webhook, in
// shipment_moved_at / last_nimbuspost_status.
//
// Both this file and auth.js used to treat 'shipped' as terminal, believing the
// webhook set it. That made shipmentHasMoved() unreachable for every pushed
// order and pushed genuine "not dispatched yet" COD cancellations into the
// manual request queue. An unpaid order whose shipment has not moved is still
// cancellable — that is the rule this restores.
function awaitingPickup(order, status) {
  return status === 'shipped' && !moneyCaptured(order) && !shipmentHasMoved(order);
}

// ── Email helper ─────────────────────────────────────────────────────────────

// ── Email templates ──────────────────────────────────────────────────────────
function cancellationEmailHtml(order, refundNote) {
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const total = order.amount_paise ? (order.amount_paise / 100) : 0;
  const rows = items.map(i => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;">${i.title || ''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;text-align:center;">${i.qty}</td>
    </tr>`).join('');
  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">inkandchai.in</p>
      <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">Order Cancelled</h2>
      <p style="color:#a09080;line-height:1.8;margin:14px 0;">
        Hi ${order.customer_name?.split(' ')[0] || 'there'}, your order has been cancelled as requested.
      </p>
      ${refundNote ? `<div style="background:#1c1916;border-left:3px solid #6dbf6d;padding:14px 18px;margin:16px 0;">
        <p style="color:#6dbf6d;margin:0;font-size:14px;">${refundNote}</p>
      </div>` : ''}
      <p style="color:#a09080;font-size:13px;">Order ID: <strong style="color:#c9a84c;">${order.razorpay_order_id || order.id}</strong></p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
        <thead><tr style="background:#1c1916;">
          <th style="padding:8px 12px;text-align:left;color:#c9a84c;font-weight:500;">Book</th>
          <th style="padding:8px 12px;text-align:center;color:#c9a84c;font-weight:500;">Qty</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${total ? `<p style="color:#a09080;font-size:13px;">Order total: <strong style="color:#f0e8d8;">₹${total.toLocaleString('en-IN')}</strong></p>` : ''}
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#a09080;font-size:13px;line-height:1.8;">
        Questions? Reply to this email or WhatsApp us. <a href="https://inkandchai.in" style="color:#c9a84c;">Browse catalogue →</a>
      </p>
      <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai · support@inkandchai.in</p>
    </div>`;
}

function adminRefundEmailHtml(order) {
  const total = order.amount_paise ? (order.amount_paise / 100) : 0;
  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#e87070;font-size:20px;font-weight:400;margin-bottom:4px;">⚠ Manual Refund Required</h1>
      <p style="color:#a09080;line-height:1.8;margin:14px 0;">
        A customer cancelled a prepaid order. The payment gateway did not support auto-refund. Please process manually.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:6px 0;color:#a09080;">Order ID</td><td style="color:#c9a84c;">${order.razorpay_order_id || order.id}</td></tr>
        <tr><td style="padding:6px 0;color:#a09080;">Payment ID</td><td style="color:#c9a84c;">${order.razorpay_payment_id || '—'}</td></tr>
        <tr><td style="padding:6px 0;color:#a09080;">Customer</td><td style="color:#f0e8d8;">${order.customer_name} &lt;${order.customer_email}&gt;</td></tr>
        <tr><td style="padding:6px 0;color:#a09080;">Amount</td><td style="color:#f0e8d8;">₹${total.toLocaleString('en-IN')}</td></tr>
      </table>
    </div>`;
}

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const SUPABASE_URL         = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Auth ─────────────────────────────────────────────────────────────────
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Not authenticated' }) };

  let userEmail;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user?.email) throw new Error('Invalid token');
    userEmail = user.email.toLowerCase();
  } catch {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session. Please sign in again.' }) };
  }

  // ── Parse body ───────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { order_id } = body;
  if (!order_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing order_id' }) };

  // ── Fetch & verify ownership ─────────────────────────────────────────────
  const { data: order, error: fetchErr } = await supabase
    .from('orders').select('*').eq('id', order_id).maybeSingle();

  if (fetchErr || !order)
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Order not found' }) };

  if ((order.customer_email || '').toLowerCase() !== userEmail)
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'You do not have permission to cancel this order' }) };

  const status = String(order.status || '').toLowerCase();
  const partialCod = isPartialCod(order);

  // Already in a terminal state — except an unpaid order sitting at the
  // warehouse under a freshly-minted AWB, which is not dispatched in any real
  // sense and falls through to the COD branch below.
  if (FINAL_STATUSES.includes(status) && !awaitingPickup(order, status)) {
    const msg = status === 'cancelled'     ? 'This order is already cancelled.' :
                status === 'refunded'      ? 'This order is already refunded.' :
                status === 'refund_pending'? 'Your refund is already being processed.' :
                ['shipped','out_for_delivery'].includes(status)
                  ? 'This order has already been dispatched. Cancellation is not possible once shipped.'
                  : status === 'delivered'
                  ? 'This order has been delivered. Please use the return option if needed.'
                  : 'This order cannot be cancelled at this stage.';
    return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: msg }) };
  }

  // Extra guard: for PREPAID orders, an assigned tracking_id means the courier
  // has the parcel — block cancellation regardless of status. COD orders are
  // exempt: the customer can cancel right up until NimbusPost reports the
  // shipment as picked up (status → 'shipped'), even if an AWB was pre-assigned
  // via the panel push. FINAL_STATUSES above already stops post-pickup cancels.
  const isPrepaidHere = status === 'paid';
  if (isPrepaidHere && order.tracking_id) {
    return {
      statusCode: 422, headers: CORS,
      body: JSON.stringify({ error: 'This order has already been dispatched (AWB: ' + order.tracking_id + '). Cancellation is not possible once a courier has picked it up.' }),
    };
  }

  // Partial COD includes a captured deposit, so it follows the same strict
  // 30-minute customer cancellation window as prepaid. It is still represented
  // as COD to NimbusPost because the balance is collected on delivery; that
  // must not accidentally grant it pure-COD's longer cancellation window.
  if (partialCod) {
    const { ageMs, minutesAgo } = cancellationAge(order);
    if (ageMs > PREPAID_WINDOW_MS) {
      return {
        statusCode: 422, headers: CORS,
        body: JSON.stringify({ error: `Partial COD orders can only be cancelled within 30 minutes of placing. This order was placed ${minutesAgo === null ? 'more than 30' : minutesAgo} minutes ago.` }),
      };
    }
    if (status === 'shipped' || shipmentHasMoved(order) || order.tracking_id) {
      return {
        statusCode: 422, headers: CORS,
        body: JSON.stringify({ error: 'This Partial COD order has already been shipped or is in transit. Cancellation is not possible after dispatch.' }),
      };
    }
  }

  // ── Case 1: COD order ────────────────────────────────────────────────────
  if (COD_CANCELLABLE.includes(status) || awaitingPickup(order, status)) {
    if (shipmentHasMoved(order)) {
      return {
        statusCode: 422, headers: CORS,
        body: JSON.stringify({ error: 'This COD order is already in transit. Cancellation is not possible after courier movement starts.' }),
      };
    }

    // Local markers said "not moved" — but they are only ever written by an
    // inbound webhook, so they are equally NULL for "nothing has happened yet"
    // and for "the pickup event never reached us". Those are opposite facts and
    // we were treating them the same: IC-R-20260807-P7DX5 was picked up by
    // Delhivery at 17:48 and cancelled at 23:5x with both columns still NULL.
    //
    // With an AWB in hand, ask NimbusPost outright. Unknown (creds, network,
    // timeout) still falls through to allowing the cancellation — the previous
    // behaviour, so a NimbusPost outage cannot trap customers in orders.
    if (order.tracking_id) {
      const live = await npShipmentMoved(order.tracking_id);
      if (live.moved === true) {
        // Persist it, or the Cancel button stays on screen and the customer
        // keeps hitting a wall with no idea why.
        await supabase.from('orders').update({
          // The courier's own event_time carries no timezone, so stamping it
          // would be a guess. This column is read as a flag, not a clock.
          shipment_moved_at: new Date().toISOString(),
          last_nimbuspost_status: String(live.status || 'picked').slice(0, 200),
        }).eq('id', order_id);
        return {
          statusCode: 422, headers: CORS,
          body: JSON.stringify({ error: `This order has already been picked up by ${order.courier_name || 'the courier'} (AWB ${order.tracking_id}). Cancellation is not possible once a parcel is with the courier — please refuse the delivery instead, or contact us.` }),
        };
      }
      if (live.moved === null) {
        console.warn(`[cancel-order] live NimbusPost check inconclusive for AWB ${order.tracking_id} (${live.error}) — allowing cancellation on local state`);
      }
    }

    // Recheck status + movement in the UPDATE itself. This closes the race where
    // an in-transit webhook arrives after the order was fetched but before the
    // customer confirms cancellation.
    // The status list must include the one we actually came in on, or the
    // atomic guard would reject the very order it just approved. shipment_moved_at
    // stays in the guard either way, so a pickup scan landing mid-request still
    // wins the race.
    const allowedStatuses = COD_CANCELLABLE.includes(status) ? COD_CANCELLABLE : [status];
    let cancelQuery = supabase
      .from('orders')
      .update({ status: 'cancelled' })
      .eq('id', order_id)
      .in('status', allowedStatuses)
      .is('shipment_moved_at', null);
    // Partial COD loses its cancellation right as soon as an AWB is assigned;
    // include that fact in the atomic update so a simultaneous panel push wins
    // the race and the customer is told to refresh instead of being refunded.
    if (partialCod) cancelQuery = cancelQuery.is('tracking_id', null);
    const cancelled = await cancelQuery.select('id').maybeSingle();
    if (cancelled.error) {
      console.error('[cancel-order] atomic COD cancellation failed:', cancelled.error.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not cancel this order. Please try again.' }) };
    }
    if (!cancelled.data) {
      return {
        statusCode: 409, headers: CORS,
        body: JSON.stringify({ error: 'The shipment status changed while cancelling. Refresh your orders to see its latest status.' }),
      };
    }

    // Cancel the order inside NimbusPost too so the courier doesn't ship it.
    // COD orders are auto-pushed to the NP panel at creation, so there's almost
    // always something to cancel there:
    //   • AWB already assigned  → cancel the SHIPMENT by AWB.
    //   • no AWB yet (unshipped panel order) → cancel the ORDER by order_number.
    // Best-effort — never blocks the customer-facing cancellation. Whatever the
    // outcome, the owner email below reports it so a failed auto-cancel gets a
    // manual follow-up instead of silently shipping a cancelled order.
    const displayId = order.razorpay_order_id || order.id;
    let npResult, npWhat;
    if (order.tracking_id) {
      npWhat = `AWB ${order.tracking_id}`;
      npResult = await cancelNimbusShipment(order.tracking_id);
    } else {
      npWhat = `order ${displayId}`;
      npResult = await cancelNimbusOrder(displayId);
    }
    if (npResult.ok) {
      console.log(`[cancel-order] NP ${npWhat} cancelled (idempotent=${!!npResult.alreadyCancelled})`);
    } else {
      console.error(`[cancel-order] NP cancel failed for ${npWhat}:`, npResult.error);
    }

    await notifyOrderCancelled({ ...order, status: 'cancelled' }, {
      kind: 'customer',   // they pressed cancel themselves
      reason: 'Your order has been cancelled as requested.'
        + (npResult && !npResult.ok
            ? ` (⚠️ NimbusPost auto-cancel failed: ${npResult.error} — please cancel ${npWhat} in the NimbusPost panel manually so it isn't shipped.)`
            : ''),
    });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      success: true,
      type: partialCod ? 'partial_cod' : 'cod',
      message: partialCod
        ? 'Order cancelled successfully. Your advance payment refund is being processed.'
        : 'Order cancelled successfully.',
      nimbuspost: npResult.ok ? 'cancelled' : `failed: ${npResult.error}`,
    }) };
  }

  // ── Case 2: Prepaid order (status "paid") — 30-minute window ────────────
  if (status === 'paid') {
    const createdAt  = order.created_at ? new Date(order.created_at).getTime() : 0;
    const ageMs      = Date.now() - createdAt;
    const minutesAgo = Math.floor(ageMs / 60000);

    if (ageMs > PREPAID_WINDOW_MS) {
      return {
        statusCode: 422, headers: CORS,
        body: JSON.stringify({ error: `Prepaid orders can only be cancelled within 30 minutes of placing. This order was placed ${minutesAgo} minutes ago.` }),
      };
    }

    const paymentId = order.razorpay_payment_id || '';
    let refundNote, newStatus, refundId;

    // Razorpay payments start with "pay_"
    if (paymentId.startsWith('pay_')) {
      try {
        const refund = await issueRazorpayRefund(paymentId, order.amount_paise, {
          notes: { reason: 'Customer cancelled within 30 minutes of order', order_id: order.razorpay_order_id || order.id },
        });
        refundId  = refund.id;
        newStatus = 'refunded';
        refundNote = `💳 Refund of ₹${(order.amount_paise / 100).toLocaleString('en-IN')} has been initiated. It will appear in your account within 5–7 business days (Refund ID: ${refundId}).`;
      } catch (err) {
        console.error('Razorpay refund failed:', err.message);
        newStatus = 'refund_pending';
        refundNote = `⏳ Your refund of ₹${(order.amount_paise / 100).toLocaleString('en-IN')} is being processed manually and will reach you within 3–5 business days.`;
      }
    } else {
      // PhonePe or unknown — flag for manual processing
      newStatus = 'refund_pending';
      refundNote = `⏳ Your refund of ₹${(order.amount_paise / 100).toLocaleString('en-IN')} is being processed and will reach you within 3–5 business days.`;
    }

    await supabase.from('orders').update({ status: newStatus }).eq('id', order_id);

    // Email customer
    if (order.customer_email) {
      await sendEmail({
        to: order.customer_email,
        subject: `Order cancelled & refund initiated — ${order.razorpay_order_id || order.id}`,
        html: cancellationEmailHtml(order, refundNote),
      });
    }

    await notifyOrderCancelled({ ...order, status: newStatus }, {
      kind: 'customer',
      reason: refundNote || 'Your order has been cancelled as requested.',
      skipEmail: true,
    });

    // Email admin for manual refunds
    if (newStatus === 'refund_pending') {
      const adminEmail = process.env.ADMIN_EMAIL || 'support@inkandchai.in';
      await sendEmail({
        to: adminEmail,
        subject: `⚠ Manual refund needed — ${order.razorpay_order_id || order.id}`,
        html: adminRefundEmailHtml(order),
      });
    }

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        success: true, type: 'prepaid', status: newStatus,
        message: newStatus === 'refunded'
          ? `Order cancelled. Refund of ₹${(order.amount_paise / 100).toLocaleString('en-IN')} initiated (5–7 business days).`
          : `Order cancelled. Refund will be processed manually within 3–5 business days.`,
      }),
    };
  }

  return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: 'This order cannot be cancelled.' }) };
};

exports._test = { shipmentHasMoved, isPartialCod, cancellationAge, PREPAID_WINDOW_MS };
