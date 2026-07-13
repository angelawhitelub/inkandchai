const { sendEmail } = require('./email');
const { sendWhatsApp } = require('./whatsapp');
const { createClient } = require('@supabase/supabase-js');
const { issuePhonePeRefund } = require('./phonepe-refund-core');
const { issueRazorpayRefund, fetchRazorpayRefundStatus } = require('./razorpay-refund');
const { notifyOwnerRefund } = require('./refund-notifications');

function moneyFromPaise(paise) {
  const amount = Number(paise || 0) / 100;
  return amount > 0 ? `Rs. ${amount.toLocaleString('en-IN')}` : '';
}

function orderId(order) {
  return order.razorpay_order_id || order.id;
}

function orderCancelledEmailHtml(order, reason) {
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const rows = items.map(i => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;">${i.title || i.name || ''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;text-align:center;">${i.qty || 1}</td>
    </tr>`).join('');
  const total = moneyFromPaise(order.amount_paise);

  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">inkandchai.in</p>
      <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">Order Cancelled</h2>
      <p style="color:#a09080;line-height:1.8;margin:14px 0;">
        Hi ${String(order.customer_name || 'there').split(' ')[0]}, your Ink &amp; Chai order has been cancelled.
      </p>
      ${reason ? `<div style="background:#1c1916;border-left:3px solid #c9a84c;padding:14px 18px;margin:16px 0;">
        <p style="color:#f0e8d8;margin:0;font-size:14px;">${reason}</p>
      </div>` : ''}
      <p style="color:#a09080;font-size:13px;">Order ID: <strong style="color:#c9a84c;">${orderId(order)}</strong></p>
      ${rows ? `<table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
        <thead><tr style="background:#1c1916;">
          <th style="padding:8px 12px;text-align:left;color:#c9a84c;font-weight:500;">Book</th>
          <th style="padding:8px 12px;text-align:center;color:#c9a84c;font-weight:500;">Qty</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>` : ''}
      ${total ? `<p style="color:#a09080;font-size:13px;">Order total: <strong style="color:#f0e8d8;">${total}</strong></p>` : ''}
      <p style="color:#a09080;font-size:13px;line-height:1.8;margin-top:18px;">
        If you have already paid for this order, our team will check the payment and help with the next step.
        For support, reply to this email or message us on WhatsApp.
      </p>
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai &middot; support@inkandchai.in</p>
    </div>`;
}

// ── Auto-refund a cancelled order if it was PREPAID (PhonePe OR Razorpay) ─────
// Fires from the single cancellation chokepoint below, so it works no matter how
// the order got cancelled (admin, courier webhook, etc.). Safe by construction:
//   • both gateways: Razorpay ('pay_...' ids) and PhonePe (all other txn ids)
//   • only orders with a captured amount
//   • never double-refunds (skips refunded / partially_refunded / refund_pending)
//   • never throws — a refund problem must not break the cancellation flow
// Payment-FAILURE cancellations (never paid) pass opts.skipRefund:true.
async function maybeAutoRefund(order) {
  // Always re-fetch the authoritative row — callers may pass a partial order
  // object (missing payment fields), and the fresh row also guards double-refund.
  const col = order.id ? 'id' : 'razorpay_order_id';
  const key = order.id || order.razorpay_order_id;
  if (!key) return { skipped: 'no-id' };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: fresh } = await supabase.from('orders').select('*').eq(col, key).maybeSingle();
  const row = fresh || order;

  if (['refunded', 'partially_refunded', 'refund_pending'].includes(row.status)) {
    return { skipped: 'already-refunded' };
  }
  // Never AUTO-refund an RTO order. When a shipment returns to origin the
  // customer often still wants it (we can re-ship), so refunds on RTO must be a
  // deliberate manual decision, not automatic. Applies to both Razorpay and
  // PhonePe (this is the shared auto-refund path). Genuine cancellations have
  // status 'cancelled'/'paid', never 'rto', so this doesn't block those.
  if (String(row.status || '').toLowerCase() === 'rto') {
    return { skipped: 'rto-no-auto-refund' };
  }
  const pid = row.razorpay_payment_id || '';
  if (!pid) return { skipped: 'no-payment-id' };
  const amountPaise = Number(row.amount_paise || 0);
  if (!amountPaise || amountPaise <= 0) return { skipped: 'no-amount' };

  const displayId = row.razorpay_order_id || row.id;
  // Razorpay payment ids start with 'pay_'; everything else is a PhonePe txn.
  const isRazorpay = pid.startsWith('pay_');

  // Mark refund_pending BEFORE calling the gateway so a concurrent cancellation
  // event can't fire a second refund for the same order.
  await supabase.from('orders').update({ status: 'refund_pending' }).eq('id', row.id);

  // ── Razorpay ──────────────────────────────────────────────────────────────
  if (isRazorpay) {
    try {
      const refund = await issueRazorpayRefund(pid, amountPaise, {
        notes: { reason: 'Order cancelled', order_id: displayId },
      });
      await supabase.from('orders').update({ status: 'refunded' }).eq('id', row.id);
      console.log(`[AUTO-REFUND] ${displayId} → Razorpay refunded refundId=${refund.id}`);
      // Confirm the true status straight from Razorpay for the owner email
      // (a fresh normal-speed refund reads 'pending' until the bank settles).
      const rzpStatus = (await fetchRazorpayRefundStatus(pid).catch(() => null))?.status || refund.status;
      await notifyRefundIssued(row, amountPaise, refund.id, { provider: 'Razorpay', state: rzpStatus });
      return { ok: true, provider: 'razorpay', state: 'refunded', nextStatus: 'refunded', merchantRefundId: refund.id };
    } catch (err) {
      // Leave it at refund_pending so the admin sees it and can retry manually.
      console.error(`[AUTO-REFUND] ${displayId} Razorpay failed: ${err.message} — left as refund_pending`);
      return { ok: false, provider: 'razorpay', error: err.message };
    }
  }

  // ── PhonePe ───────────────────────────────────────────────────────────────
  const res = await issuePhonePeRefund({ displayId, amountPaise });
  if (res.ok) {
    await supabase.from('orders').update({ status: res.nextStatus }).eq('id', row.id);
    console.log(`[AUTO-REFUND] ${displayId} → ${res.state} (${res.nextStatus}) refundId=${res.merchantRefundId}`);
    // Tell the customer their money is on its way + email the owner.
    await notifyRefundIssued(row, amountPaise, res.merchantRefundId, { provider: 'PhonePe', state: res.state });
  } else {
    // Leave it at refund_pending so the admin sees it and can retry manually.
    console.error(`[AUTO-REFUND] ${displayId} failed: ${res.error} — left as refund_pending for manual retry`);
  }
  return res;
}

function refundProcessedEmailHtml(order, amountPaise, refundId) {
  const amount = moneyFromPaise(amountPaise);
  const first = String(order.customer_name || 'there').split(' ')[0];
  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">inkandchai.in</p>
      <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">Your refund is on its way 💛</h2>
      <p style="color:#a09080;line-height:1.8;margin:14px 0;">
        Hi ${first}, your order <strong style="color:#c9a84c;">${orderId(order)}</strong> was cancelled and
        we've issued a refund${amount ? ` of <strong style="color:#f0e8d8;">${amount}</strong>` : ''} to your
        original payment method.
      </p>
      <div style="background:#1c1916;border-left:3px solid #c9a84c;padding:14px 18px;margin:16px 0;">
        <p style="color:#f0e8d8;margin:0;font-size:14px;">Refund reference: <strong style="color:#c9a84c;">${refundId}</strong></p>
        <p style="color:#a09080;margin:8px 0 0;font-size:13px;">The amount will reflect in your account within <strong style="color:#f0e8d8;">5–7 business days</strong>.</p>
      </div>
      <p style="color:#a09080;font-size:13px;line-height:1.8;">If you don't see it after 7 days, just reply to this email or message us on WhatsApp and we'll help right away.</p>
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai &middot; support@inkandchai.in</p>
    </div>`;
}

// Best-effort refund confirmation — customer email + WhatsApp, AND an owner
// email. Only ever called on the success branches of maybeAutoRefund (i.e. the
// gateway accepted/processed the refund), so the owner is notified only when a
// refund has actually been issued. `meta` carries { provider, state } for the
// owner email. Never throws.
async function notifyRefundIssued(order, amountPaise, refundId, meta = {}) {
  try {
    if (order.customer_email) {
      await sendEmail({
        to: order.customer_email,
        subject: `Refund issued — ${orderId(order)}`,
        html: refundProcessedEmailHtml(order, amountPaise, refundId),
      });
    }
    if (order.customer_phone) {
      await sendWhatsApp({
        to: order.customer_phone,
        template: process.env.WHATSAPP_REFUND_TEMPLATE || 'refund_processed',
        params: [
          String(order.customer_name || 'there').split(' ')[0],
          orderId(order),
          moneyFromPaise(amountPaise) || 'the order amount',
        ],
      });
    }
    // Owner notification — the store owner asked to be emailed on every issued refund.
    await notifyOwnerRefund(order, amountPaise, { ...meta, refundId });
  } catch (e) {
    console.error('[AUTO-REFUND] confirmation notify error:', e.message);
  }
}

function ownerCancelledEmailHtml(order, reason, refundResult) {
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const rows = items.map(i => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;">${i.title || i.name || ''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;text-align:center;">${i.qty || 1}</td>
    </tr>`).join('');
  const total = moneyFromPaise(order.amount_paise);
  const paidVia = order.razorpay_payment_id
    ? (String(order.razorpay_payment_id).startsWith('pay_') ? 'Razorpay' : 'PhonePe')
    : 'Cash on Delivery';
  const refundLine = refundResult && refundResult.ok
    ? `<p style="color:#6dbf6d;font-size:13px;">💛 Auto-refund initiated — ref: <strong style="color:#c9a84c;">${refundResult.merchantRefundId || '—'}</strong> · state: ${refundResult.state || '—'}</p>`
    : refundResult && refundResult.skipped
      ? `<p style="color:#a09080;font-size:12px;">Refund step: skipped (${refundResult.skipped}).</p>`
      : refundResult && refundResult.error
        ? `<p style="color:#e87070;font-size:13px;">⚠️ Auto-refund attempt failed: ${refundResult.error}. Order left as refund_pending — retry from admin panel.</p>`
        : '';

  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:24px;">Admin notification</p>
      <h2 style="color:#e87070;font-size:20px;font-weight:400;">Order Cancelled</h2>
      <p style="color:#a09080;font-size:13px;">Order ID: <strong style="color:#c9a84c;">${orderId(order)}</strong></p>
      <div style="background:#1c1916;border-left:3px solid #e87070;padding:14px 18px;margin:16px 0;">
        <p style="color:#f0e8d8;margin:0;font-size:14px;">${reason || 'No reason provided'}</p>
      </div>
      <table style="font-size:14px;line-height:1.8;color:#f0e8d8;">
        <tr><td style="color:#a09080;padding-right:16px;">Name</td><td>${order.customer_name || '—'}</td></tr>
        <tr><td style="color:#a09080;padding-right:16px;">Phone</td><td>${order.customer_phone || '—'}</td></tr>
        <tr><td style="color:#a09080;padding-right:16px;">Email</td><td>${order.customer_email || '—'}</td></tr>
        <tr><td style="color:#a09080;padding-right:16px;">Address</td><td>${order.customer_address || '—'}</td></tr>
        <tr><td style="color:#a09080;padding-right:16px;">Paid via</td><td>${paidVia}</td></tr>
        ${total ? `<tr><td style="color:#a09080;padding-right:16px;">Total</td><td><strong style="color:#c9a84c;">${total}</strong></td></tr>` : ''}
      </table>
      ${rows ? `<table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
        <thead><tr style="background:#1c1916;">
          <th style="padding:8px 12px;text-align:left;color:#c9a84c;font-weight:500;">Book</th>
          <th style="padding:8px 12px;text-align:center;color:#c9a84c;font-weight:500;">Qty</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>` : ''}
      ${refundLine}
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#7a6330;font-size:11px;">Sent to the store owner &middot; inkandchai.in</p>
    </div>`;
}

async function notifyOrderCancelled(order, opts = {}) {
  if (!order) return { email: false, whatsapp: false };

  const id = orderId(order);
  const firstName = String(order.customer_name || 'there').split(' ')[0];
  const reason = opts.reason || 'The courier/order status update marked this order as cancelled.';
  const result = { email: false, whatsapp: false, ownerEmail: false };

  // Auto-refund prepaid PhonePe orders (unless the caller opted out, e.g. a
  // payment-failure cancellation where nothing was ever captured).
  if (!opts.skipRefund) {
    try {
      const r = await maybeAutoRefund(order);
      result.refund = r;
    } catch (e) {
      console.error('[AUTO-REFUND] error:', e.message);
    }
  }

  if (!opts.skipEmail && order.customer_email) {
    const email = await sendEmail({
      to: order.customer_email,
      subject: `Order cancelled - ${id}`,
      html: orderCancelledEmailHtml(order, reason),
    });
    result.email = !!email?.ok;
  }

  if (!opts.skipWhatsApp && order.customer_phone) {
    await sendWhatsApp({
      to: order.customer_phone,
      template: process.env.WHATSAPP_ORDER_CANCELLED_TEMPLATE || 'order_cancelled',
      params: [firstName, id],
    });
    result.whatsapp = true;
  }

  // Owner notification — same pattern as the "new order" email so the store
  // owner sees every cancellation in their inbox alongside new orders.
  // Suppressed for payment-failure cancellations (opts.paymentFailed): those
  // are just abandoned/failed checkouts where nothing was ever captured, and
  // emailing the owner about every failed payment is noise. The customer-facing
  // notification still goes out as normal.
  const ownerEmail = process.env.STORE_OWNER_EMAIL;
  if (ownerEmail && !opts.skipOwnerEmail && !opts.paymentFailed) {
    try {
      const total = moneyFromPaise(order.amount_paise);
      const sent = await sendEmail({
        to: ownerEmail,
        subject: `❌ Order Cancelled ${id}${total ? ` — ${total}` : ''}`,
        html: ownerCancelledEmailHtml(order, reason, result.refund),
      });
      result.ownerEmail = !!sent?.ok;
    } catch (e) {
      console.error('[notifyOrderCancelled] owner email:', e.message);
    }
  }

  return result;
}

module.exports = { notifyOrderCancelled };
