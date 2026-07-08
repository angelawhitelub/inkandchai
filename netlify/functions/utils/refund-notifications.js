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
 * The Meta template `refund_initiated` must be created + approved in the
 * WhatsApp Business Manager with these variables:
 *   {{1}} customer first name
 *   {{2}} order id (IC-YYYYMMDD-XXXXX)
 *   {{3}} amount (₹499)
 * If not approved yet, WhatsApp send silently no-ops — email still sends.
 */

const { sendEmail } = require('./email');
const { sendWhatsApp } = require('./whatsapp');

function firstName(name) {
  return String(name || 'there').trim().split(/\s+/)[0] || 'there';
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
  const amt = `₹${(amountPaise / 100).toLocaleString('en-IN')}`;

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
        template: 'refund_initiated',
        params: [firstName(order.customer_name), String(oid), amt],
      }).catch(e => console.error('refund whatsapp:', e.message))
    : Promise.resolve();

  await Promise.all([emailPromise, waPromise]);

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

module.exports = { sendRefundInitiated, refundInitiatedEmailHtml };
