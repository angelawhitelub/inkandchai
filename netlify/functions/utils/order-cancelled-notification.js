const { sendEmail } = require('./email');
const { sendWhatsApp } = require('./whatsapp');
const { createClient } = require('@supabase/supabase-js');
const { issuePhonePeRefund } = require('./phonepe-refund-core');

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

// ── Auto-refund a cancelled order if it was PREPAID via PhonePe ───────────────
// Fires from the single cancellation chokepoint below, so it works no matter how
// the order got cancelled (admin, courier webhook, etc.). Safe by construction:
//   • only PhonePe payments (razorpay_payment_id present, not a Razorpay 'pay_' id)
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
  // PhonePe payments only. Razorpay ids start with 'pay_' → use their dashboard.
  const pid = row.razorpay_payment_id || '';
  if (!pid || pid.startsWith('pay_')) return { skipped: 'not-phonepe' };
  const amountPaise = Number(row.amount_paise || 0);
  if (!amountPaise || amountPaise <= 0) return { skipped: 'no-amount' };

  const displayId = row.razorpay_order_id || row.id;

  // Mark refund_pending BEFORE calling PhonePe so a concurrent cancellation event
  // can't fire a second refund for the same order.
  await supabase.from('orders').update({ status: 'refund_pending' }).eq('id', row.id);

  const res = await issuePhonePeRefund({ displayId, amountPaise });
  if (res.ok) {
    await supabase.from('orders').update({ status: res.nextStatus }).eq('id', row.id);
    console.log(`[AUTO-REFUND] ${displayId} → ${res.state} (${res.nextStatus}) refundId=${res.merchantRefundId}`);
  } else {
    // Leave it at refund_pending so the admin sees it and can retry manually.
    console.error(`[AUTO-REFUND] ${displayId} failed: ${res.error} — left as refund_pending for manual retry`);
  }
  return res;
}

async function notifyOrderCancelled(order, opts = {}) {
  if (!order) return { email: false, whatsapp: false };

  const id = orderId(order);
  const firstName = String(order.customer_name || 'there').split(' ')[0];
  const reason = opts.reason || 'The courier/order status update marked this order as cancelled.';
  const result = { email: false, whatsapp: false };

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

  return result;
}

module.exports = { notifyOrderCancelled };
