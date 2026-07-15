/**
 * Auto-refund a prepaid return once the returned parcel is scanned delivered
 * BACK to us. Called from nimbuspost-webhook when an AWB event doesn't match a
 * forward order — it may be a reverse (return) AWB.
 *
 * Safety:
 *   • Only acts on return_requests rows in refund_status 'awaiting_return_delivery'
 *     (set only for prepaid + original-method returns).
 *   • Atomically CLAIMS the row (awaiting_return_delivery → refunding) before
 *     calling the payment gateway, so a duplicate webhook can't double-refund.
 *   • Razorpay is auto-refunded (deterministic, reusable API). PhonePe / unknown
 *     providers are flagged manual_refund_pending and the owner is alerted —
 *     never a blind auto-call.
 */

const { issueRazorpayRefund } = require('./razorpay-refund');
const { sendEmail } = require('./email');
const { sendText }  = require('./whatsapp');

async function ownerAlert(text) {
  const phone = process.env.STORE_OWNER_PHONE;
  if (phone) { try { await sendText(phone, text); } catch (_) {} }
}

async function handleReturnAwbDelivered(supabase, awb) {
  const tracking = String(awb || '').trim();
  if (!tracking) return { matched: false };

  const { data: ret, error } = await supabase
    .from('return_requests')
    .select('*')
    .eq('awb', tracking)
    .eq('refund_status', 'awaiting_return_delivery')
    .maybeSingle();
  if (error || !ret) return { matched: false };

  // Atomic claim — only one webhook delivery wins.
  const claim = await supabase
    .from('return_requests')
    .update({ refund_status: 'refunding' })
    .eq('id', ret.id)
    .eq('refund_status', 'awaiting_return_delivery')
    .select('id');
  if (claim.error || !claim.data || claim.data.length === 0) {
    return { matched: true, claimed: false };  // someone else is handling it
  }

  const oid = ret.order_display_id || ret.order_id;
  const { data: order } = await supabase.from('orders').select('*').eq('id', ret.order_id).maybeSingle();
  const paymentId  = String(order?.razorpay_payment_id || '');
  const amountPaise = Number(ret.refund_amount_paise) || Number(order?.amount_paise) || 0;
  const amountRs = Math.round(amountPaise / 100);

  // Razorpay → auto-refund via API.
  if (paymentId.startsWith('pay_')) {
    try {
      const r = await issueRazorpayRefund(paymentId, amountPaise, {
        notes: { reason: 'customer_return', return_request_id: String(ret.id), order: String(oid) },
      });
      await supabase.from('return_requests').update({
        refund_status: 'refunded',
        refunded_at:   new Date().toISOString(),
        refund_ref:    r?.id || null,
      }).eq('id', ret.id);

      if (ret.customer_email) {
        await sendEmail({
          to: ret.customer_email,
          subject: `Refund issued for your return (${oid})`,
          html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#2a2018;background:#faf7f2;">
            <h2 style="font-family:Georgia,serif;font-weight:400;color:#8a6a1f;">Refund on its way ✅</h2>
            <p>Hi ${String(ret.customer_name||'there').split(' ')[0]}, we've received your returned book and issued a refund of <strong>₹${amountRs.toLocaleString('en-IN')}</strong> to your original payment method.</p>
            <p style="font-size:13px;color:#5a4a38;">It usually appears within 5–7 business days. Reference: ${r?.id || '—'}.</p>
            <p style="font-size:12px;color:#8a7a62;margin-top:20px;">Ink &amp; Chai · inkandchai.in</p>
          </div>`,
        }).catch(() => {});
      }
      await ownerAlert(`✅ Auto-refund issued\nOrder: ${oid}\nReturn received → ₹${amountRs} refunded to customer (Razorpay ${r?.id || ''}).`);
      return { matched: true, refunded: true, provider: 'razorpay', refundId: r?.id || null };
    } catch (e) {
      // Revert so it can be retried / handled by hand; never leave it stuck.
      await supabase.from('return_requests').update({ refund_status: 'awaiting_return_delivery' }).eq('id', ret.id);
      await ownerAlert(`⚠️ Auto-refund FAILED for return ${oid}: ${e.message}\nReturn is received — please refund ₹${amountRs} manually from the admin.`);
      return { matched: true, refunded: false, error: e.message };
    }
  }

  // PhonePe / unknown provider → don't auto-call; flag for manual refund.
  await supabase.from('return_requests').update({ refund_status: 'manual_refund_pending' }).eq('id', ret.id);
  await ownerAlert(`🔁 Return received — refund the customer manually\nOrder: ${oid}\nAmount: ₹${amountRs}\n(Prepaid via PhonePe/other — issue the refund from the admin.)`);
  return { matched: true, refunded: false, manual: true };
}

module.exports = { handleReturnAwbDelivered };
