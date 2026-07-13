/**
 * Refund-initiated notifications — email + WhatsApp.
 *
 * Fires ONCE per order (guarded by orders.refund_notified_at) as soon as we
 * confirm the refund has been accepted by the payment gateway (state PENDING
 * or COMPLETED). Tells the customer:
 *   • refund has been initiated
 *   • amount refunded
 *   • usually reflects in 2-3 business days in their original payment method
 *
 * Matches the existing WhatsApp Business template `refund_processed` (already
 * approved in the Meta panel):
 *   Body: "Hi {{1}}, your refund for order {{2}} of Rs {{3}} has been issued
 *          to your PhonePe payment method. It will reflect in your account
 *          within 5–7 business days. Thank you, Ink & Chai."
 * Params:
 *   {{1}} customer first name
 *   {{2}} order id (IC-YYYYMMDD-XXXXX)
 *   {{3}} amount as a plain number (the template supplies "Rs " itself)
 */

const { sendEmail } = require('./email');
const { sendWhatsApp } = require('./whatsapp');

function firstName(name) {
  return String(name || 'there').trim().split(/\s+/)[0] || 'there';
}

// Human label for the gateway state, if we have it.
function stateLabel(state) {
  const s = String(state || '').toLowerCase();
  if (s === 'processed' || s === 'completed') return 'Completed (settled)';
  if (s === 'pending')                        return 'Pending (accepted, settling in 2–7 days)';
  if (s === 'failed')                         return 'Failed';
  return state ? String(state) : 'Accepted by gateway';
}

function ownerRefundEmailHtml(order, amtPaise, { provider, refundId, state } = {}) {
  const amt = `₹${(amtPaise / 100).toLocaleString('en-IN')}`;
  const oid = order.razorpay_order_id || order.id || '';
  return `<div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
    <h1 style="color:#c9a84c;font-size:22px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
    <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:24px;">Admin notification</p>
    <h2 style="color:#6dbf6d;font-size:20px;font-weight:400;">💸 Refund issued</h2>
    <table style="font-size:14px;line-height:1.9;color:#f0e8d8;margin:10px 0;">
      <tr><td style="color:#a09080;padding-right:16px;">Order</td><td><strong style="color:#c9a84c;">${oid}</strong></td></tr>
      <tr><td style="color:#a09080;padding-right:16px;">Customer</td><td>${order.customer_name || '—'}</td></tr>
      <tr><td style="color:#a09080;padding-right:16px;">Amount</td><td><strong style="color:#6dbf6d;">${amt}</strong></td></tr>
      <tr><td style="color:#a09080;padding-right:16px;">Via</td><td>${provider || (String(order.razorpay_payment_id||'').startsWith('pay_') ? 'Razorpay' : 'PhonePe')}</td></tr>
      ${refundId ? `<tr><td style="color:#a09080;padding-right:16px;">Refund ref</td><td style="font-family:Menlo,Consolas,monospace;">${refundId}</td></tr>` : ''}
      <tr><td style="color:#a09080;padding-right:16px;">Status</td><td>${stateLabel(state)}</td></tr>
    </table>
    <p style="color:#a09080;font-size:12px;line-height:1.7;margin-top:16px;">The customer has been notified by email + WhatsApp. Normal-speed refunds settle in 2–7 business days.</p>
    <hr style="border:none;border-top:1px solid #2a2a2a;margin:28px 0;"/>
    <p style="color:#7a6330;font-size:11px;">Sent to the store owner &middot; inkandchai.in</p>
  </div>`;
}

/**
 * Email the store owner that a refund was successfully issued. Best-effort,
 * never throws. No-ops if STORE_OWNER_EMAIL is unset.
 */
async function notifyOwnerRefund(order, amountPaise, meta = {}) {
  const ownerEmail = process.env.STORE_OWNER_EMAIL;
  if (!ownerEmail || !order || amountPaise <= 0) return { sent: false };
  const oid = order.razorpay_order_id || order.id || '';
  const amt = `₹${(amountPaise / 100).toLocaleString('en-IN')}`;
  try {
    const r = await sendEmail({
      to: ownerEmail,
      subject: `💸 Refund issued ${oid} — ${amt}`,
      html: ownerRefundEmailHtml(order, amountPaise, meta),
    });
    return { sent: !!r?.ok };
  } catch (e) {
    console.error('owner refund email:', e.message);
    return { sent: false };
  }
}

function refundInitiatedEmailHtml(order, amtPaise) {
  const amt = `₹${(amtPaise / 100).toLocaleString('en-IN')}`;
  const oid = order.razorpay_order_id || order.id || '';
  return `<div style="font-family:Georgia,serif;color:#3a2f25;max-width:520px;margin:0 auto;padding:24px;background:#faf7f2;">
    <h2 style="font-family:Georgia,serif;font-weight:400;color:#8a6a1f;margin:0 0 12px;">Your refund is on its way 💚</h2>
    <p>Hi ${firstName(order.customer_name)},</p>
    <p>We've initiated a refund of <strong>${amt}</strong> for your order <strong>${oid}</strong>.</p>
    <p><strong>Timeline:</strong> the amount will reflect in your original payment method within <strong>2–3 business days</strong>. Some banks may take a little longer — up to 5–7 business days in rare cases.</p>
    <p>You don't need to do anything from your side. Once the money reaches your bank, you'll see it as a credit against the original transaction.</p>
    <p style="color:#6f6255;font-size:13px;margin-top:24px;">If you don't see the refund after 7 business days, just reply to this email or WhatsApp us at +91 76784 00508 with your Order ID and we'll chase it with our payment provider right away.</p>
    <p style="color:#6f6255;font-size:13px;">Thank you for shopping with us,<br>Ink &amp; Chai</p>
  </div>`;
}

/**
 * Send refund-initiated notifications to the customer.
 *
 * @param {object} order       Full orders row (needs customer_email, customer_phone, customer_name, razorpay_order_id/id)
 * @param {number} amountPaise Amount refunded, in paise
 * @param {object} [opts]
 * @param {object} [opts.supabase]  Supabase client — if provided, stamps refund_notified_at + skips if already stamped
 * @returns {Promise<{sent: boolean, skipped?: string}>}
 */
async function sendRefundInitiated(order, amountPaise, { supabase } = {}) {
  if (!order || amountPaise <= 0) return { sent: false, skipped: 'no_amount' };

  // Dedup: if we already notified, skip. Cheap protection against retry loops
  // notifying multiple times as refund state flips between PENDING/COMPLETED.
  if (order.refund_notified_at) return { sent: false, skipped: 'already_notified' };

  const oid = order.razorpay_order_id || order.id || '';
  // Template body prepends "Rs " itself — pass a plain, comma-formatted number.
  const amtPlain = (amountPaise / 100).toLocaleString('en-IN');

  const emailPromise = order.customer_email
    ? sendEmail({
        to: order.customer_email,
        subject: `Refund initiated — ${oid}`,
        html: refundInitiatedEmailHtml(order, amountPaise),
      }).catch(e => console.error('refund email:', e.message))
    : Promise.resolve();

  const waPromise = order.customer_phone
    ? sendWhatsApp({
        to: order.customer_phone,
        template: 'refund_processed',
        params: [firstName(order.customer_name), String(oid), amtPlain],
      }).catch(e => console.error('refund whatsapp:', e.message))
    : Promise.resolve();

  // Notify the store owner too — same success+dedup gate as the customer, so the
  // owner is emailed exactly once, only when a refund has actually been issued.
  const ownerProvider = String(order.razorpay_payment_id || '').startsWith('pay_') ? 'Razorpay' : 'PhonePe';
  const ownerPromise = notifyOwnerRefund(order, amountPaise, {
    provider: ownerProvider,
    refundId: order.refund_id || null,
    state: order.refund_state || 'processed',
  }).catch(e => console.error('owner refund notify:', e.message));

  await Promise.all([emailPromise, waPromise, ownerPromise]);

  // Stamp so we don't renotify. Best-effort: if the column doesn't exist yet
  // (SQL migration not run), swallow the error rather than blocking refunds.
  if (supabase && order.id) {
    try {
      await supabase.from('orders')
        .update({ refund_notified_at: new Date().toISOString() })
        .eq('id', order.id);
    } catch (e) { console.error('refund_notified_at stamp:', e.message); }
  }

  return { sent: true };
}

module.exports = { sendRefundInitiated, refundInitiatedEmailHtml, notifyOwnerRefund };
