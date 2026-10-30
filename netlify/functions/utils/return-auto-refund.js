/**
 * Auto-refund a prepaid return once the returned parcel is scanned delivered
 * BACK to us. Called from nimbuspost-webhook when an AWB event doesn't match a
 * forward order — it may be a reverse (return) AWB.
 *
 * Called too by return-tracking-scheduled, when a reverse AWB booked straight
 * with XpressBees (which sends no webhook here) is tracked delivered back.
 *
 * Store-credit returns are settled here as well: the code (the refund, plus the
 * ₹50 bonus only on a return requested before it ended, walletBonusRupees) is
 * minted and emailed on receipt, never before the books are back.
 *
 * Safety:
 *   • Only acts on return_requests rows in refund_status 'awaiting_return_delivery'
 *     (prepaid original-method returns, and store-credit returns).
 *   • Atomically CLAIMS the row (awaiting_return_delivery → refunding) before
 *     calling the payment gateway, so a duplicate webhook can't double-refund.
 *   • Razorpay is auto-refunded (deterministic, reusable API). PhonePe / unknown
 *     providers are flagged manual_refund_pending and the owner is alerted —
 *     never a blind auto-call.
 */

const { issueRazorpayRefund } = require('./razorpay-refund');
const { mintWalletCredit, walletBonusRupees } = require('./return-refund');
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
    .eq('awb', tracking)                              // ONLY the reverse AWB assigned to this return
    .eq('refund_status', 'awaiting_return_delivery') // not already refunded / claimed
    .maybeSingle();
  if (error || !ret) return { matched: false };
  const wallet = ret.refund_method === 'wallet';
  // COD original-method refunds are a manual UPI/bank payout, never automatic.
  if (!wallet && !(ret.refund_method === 'original' && ret.payment_type === 'prepaid')) return { matched: false };

  // Defensive guards — the refund must be tied to THIS return's own assigned
  // reverse AWB, and the return must not have been rejected/cancelled.
  if (!ret.awb || String(ret.awb).trim() !== tracking) return { matched: false };
  if (['rejected', 'cancelled'].includes(String(ret.status || '').toLowerCase())) return { matched: false };

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

  if (wallet) {
    const bonus = walletBonusRupees(ret.created_at);
    try {
      const minted = await mintWalletCredit(supabase, { order: order || ret, valuePaise: amountPaise + bonus * 100 });
      const creditRs = Math.round(minted.value_paise / 100);
      await supabase.from('return_requests').update({
        refund_status: 'wallet_issued', wallet_code: minted.code, refunded_at: new Date().toISOString(),
      }).eq('id', ret.id);
      if (ret.customer_email) {
        await sendEmail({
          to: ret.customer_email,
          subject: `Your ₹${creditRs} store credit is ready (${oid})`,
          html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#2a2018;background:#faf7f2;">
            <h2 style="font-family:Georgia,serif;font-weight:400;color:#8a6a1f;">Return received ✅</h2>
            <p>Hi ${String(ret.customer_name||'there').split(' ')[0]}, your returned books have reached us. Here is your Ink &amp; Chai store credit:</p>
            <div style="margin:16px 0;padding:16px;background:#f4ecd9;border:1px dashed #c9a84c;text-align:center;">
              <div style="font-family:monospace;font-size:22px;color:#8a3a1f;margin:4px 0;">${minted.code}</div>
              <div style="font-size:20px;color:#4a9d4a;font-weight:600;">₹${creditRs.toLocaleString('en-IN')}</div>
              <div style="font-size:12px;color:#8a7a62;">${bonus ? `(₹${amountRs} refund + ₹${bonus} bonus) · ` : ''}valid 6 months</div>
            </div>
            <p style="font-size:13px;">Enter the code in the coupon box at checkout on your next order.</p>
            <p style="font-size:12px;color:#8a7a62;margin-top:20px;">Ink &amp; Chai · inkandchai.in</p>
          </div>`,
        }).catch(() => {});
      }
      await ownerAlert(`✅ Return received → store credit issued\nOrder: ${oid}\n${minted.code} worth ₹${creditRs} emailed to the customer.`);
      return { matched: true, refunded: true, provider: 'wallet', code: minted.code };
    } catch (e) {
      await supabase.from('return_requests').update({ refund_status: 'awaiting_return_delivery' }).eq('id', ret.id);
      await ownerAlert(`⚠️ Store credit FAILED for return ${oid}: ${e.message}\nReturn is received — issue ₹${amountRs + bonus} credit by hand.`);
      return { matched: true, refunded: false, error: e.message };
    }
  }

  // Razorpay → auto-refund via API.
  if (paymentId.startsWith('pay_')) {
    try {
      const r = await issueRazorpayRefund(paymentId, amountPaise, {
        notes: { reason: 'customer_return', return_request_id: String(ret.id), order: String(oid) },
        supabase,
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
