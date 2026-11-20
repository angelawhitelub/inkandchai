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
 * minted and emailed as soon as the courier picks the books up (owner, 16 Nov
 * 2026; was on receipt). Money back to a payment method still waits for receipt.
 *
 * Safety:
 *   • Only acts on return_requests rows in refund_status 'awaiting_return_delivery'
 *     (prepaid original-method returns, and store-credit returns).
 *   • Atomically CLAIMS the row (awaiting_return_delivery → refunding) before
 *     calling the payment gateway, so a duplicate webhook can't double-refund.
 *   • Razorpay and PhonePe are both auto-refunded (owner, 20 Nov 2026: PhonePe
 *     returns used to stop at manual_refund_pending, and 24 customers waited).
 *     PhonePe uses the attempt-numbered refund id (utils/refund-id), reserved on
 *     the order before the call, and an earlier attempt on the same return is
 *     asked about first, so the same return is never paid twice.
 *   • Anything else, or any refusal, goes to manual_refund_pending with an owner
 *     alert; the admin Returns tab can then retry it with one button.
 */

const { issueRazorpayRefund } = require('./razorpay-refund');
const { issuePhonePeRefund } = require('./phonepe-refund-core');
const { getRefundStatus, refundUtrFrom } = require('./phonepe-core');
const { sendRefundInitiated } = require('./refund-notifications');
const { mintWalletCredit, walletBonusRupees } = require('./return-refund');
const { sendEmail } = require('./email');
const { sendText }  = require('./whatsapp');

async function ownerAlert(text) {
  const phone = process.env.STORE_OWNER_PHONE;
  if (phone) { try { await sendText(phone, text); } catch (_) {} }
}

async function handleReturnAwbDelivered(supabase, awb, { on = 'delivered' } = {}) {
  const atPickup = on === 'picked_up';
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
  // Only store credit is issued at pickup; money back waits for the parcel.
  if (atPickup && !wallet) return { matched: false };
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
            <h2 style="font-family:Georgia,serif;font-weight:400;color:#8a6a1f;">${atPickup ? 'Return picked up ✅' : 'Return received ✅'}</h2>
            <p>Hi ${String(ret.customer_name||'there').split(' ')[0]}, ${atPickup ? 'the courier has picked up your returned books' : 'your returned books have reached us'}. Here is your Ink &amp; Chai store credit:</p>
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
      await ownerAlert(`✅ Return ${atPickup ? 'picked up' : 'received'} → store credit issued\nOrder: ${oid}\n${minted.code} worth ₹${creditRs} emailed to the customer.`);
      return { matched: true, refunded: true, provider: 'wallet', code: minted.code };
    } catch (e) {
      await supabase.from('return_requests').update({ refund_status: 'awaiting_return_delivery' }).eq('id', ret.id);
      await ownerAlert(`⚠️ Store credit FAILED for return ${oid}: ${e.message}\nReturn is ${atPickup ? 'picked up' : 'received'} — issue ₹${amountRs + bonus} credit by hand.`);
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

  // PhonePe → auto-refund via API (same helper the cancel path uses).
  const out = await payReturnByPhonePe(supabase, ret, order);
  if (out.ok) return { matched: true, refunded: true, provider: 'phonepe', refundId: out.refundRef };
  return { matched: true, refunded: false, manual: true, error: out.error };
}

/**
 * Pay a received prepaid return back through PhonePe.
 *
 * The caller must hold the row first (refund_status 'refunding'), so two
 * callers can never both get here for the same return. Every path ends in a
 * settled state: 'refunded' with refund_ref, or 'manual_refund_pending' with an
 * owner alert. The order's own status is left alone (a returned order is not a
 * cancelled one); phonepe-webhook recognises the refund by refund_ref.
 *
 * deps is for tests only.
 */
async function payReturnByPhonePe(supabase, ret, order, deps = {}) {
  const issue = deps.issuePhonePeRefund || issuePhonePeRefund;
  const status = deps.getRefundStatus || getRefundStatus;
  const alert = deps.ownerAlert || ownerAlert;
  const now = () => new Date().toISOString();
  const oid = ret.order_display_id || ret.order_id;
  const displayId = String(order?.razorpay_order_id || '');
  const amountPaise = Number(ret.refund_amount_paise) || 0;
  const amountRs = Math.round(amountPaise / 100);

  const manual = async (why, refundRef) => {
    const patch = { refund_status: 'manual_refund_pending' };
    if (refundRef) patch.refund_ref = refundRef;
    await supabase.from('return_requests').update(patch).eq('id', ret.id);
    await alert(`⚠️ Return refund NOT paid automatically\nOrder: ${oid}\nAmount: ₹${amountRs}\nWhy: ${why}\nRetry from admin → Returns, or refund by hand.`);
    return { ok: false, error: why };
  };
  const paid = async (refundRef, state, statusData) => {
    await supabase.from('return_requests').update({
      refund_status: 'refunded', refunded_at: now(), refund_ref: refundRef,
    }).eq('id', ret.id);
    await alert(`✅ Return refund issued\nOrder: ${oid}\n₹${amountRs} refunded to the customer's PhonePe payment (${refundRef}, ${state || 'accepted'}).`);
    // The customer hears once PhonePe says COMPLETED, with the bank UTR, the
    // same rule as every other refund. PENDING (the usual first answer) is told
    // by phonepe-webhook, or by the hourly syncReturnRefunds if that is missed.
    if (String(state || '').toUpperCase() === 'COMPLETED') {
      await settleReturnRefundEvent(supabase, refundRef, 'COMPLETED', deps, statusData).catch(() => {});
    }
    return { ok: true, refundRef, state };
  };

  if (!order || !displayId) return manual('order not found');
  if (String(order.razorpay_payment_id || '').startsWith('pay_')) return manual('paid by Razorpay, not PhonePe');
  if (!String(order.razorpay_payment_id || '')) return manual('no PhonePe payment on the order');
  if (!(amountPaise > 0)) return manual('refund amount is zero');
  if (amountPaise > (Number(order.amount_paise) || 0)) return manual(`refund ₹${amountRs} is more than the order total`);
  if (order.refund_state === 'COMPLETED' || ['refunded', 'partially_refunded'].includes(order.status)) {
    return manual('the order already shows a refund; check PhonePe before paying again');
  }

  // An earlier attempt on this return: ask PhonePe what became of it before
  // issuing anything new. Only a definite failure allows a fresh attempt.
  if (ret.refund_ref) {
    let st;
    try { st = await status(ret.refund_ref); } catch (e) { return manual(`could not check earlier refund ${ret.refund_ref}: ${e.message}`, ret.refund_ref); }
    if (st.state === 'COMPLETED' || st.state === 'PENDING') return paid(ret.refund_ref, st.state, st.data);
    const gone = st.state === 'FAILED' || /NOT_FOUND/i.test(JSON.stringify(st.data || {}));
    if (!gone) return manual(`earlier refund ${ret.refund_ref} is "${st.state || 'unknown'}"`, ret.refund_ref);
  }

  // Reserve this attempt's merchant refund id on the order, so no other refund
  // path can mint the same one.
  const attempt = Number(order.refund_attempts) || 0;
  let reserve = supabase.from('orders').update({ refund_attempts: attempt + 1 }).eq('id', order.id);
  reserve = order.refund_attempts == null ? reserve.is('refund_attempts', null) : reserve.eq('refund_attempts', attempt);
  const held = await reserve.select('id');
  if (held.error || !held.data || held.data.length === 0) return manual('another refund on this order was running; try again');

  let res;
  try { res = await issue({ displayId, amountPaise, attempt }); }
  catch (e) { res = { ok: false, error: e.message }; }
  const refundRef = res.merchantRefundId || `REFUND-${displayId}-A${attempt}`;
  if (!res.ok) return manual(`PhonePe: ${res.error || 'refused'}`, refundRef);
  return paid(refundRef, res.state, res.data);
}

/**
 * A PhonePe refund callback for a RETURN refund (matched on return_requests.
 * refund_ref). Returns null when the id is not a return refund, so the webhook
 * carries on with its order logic. The order row is never touched here: the
 * book came back, the order was not cancelled.
 *   COMPLETED → the return is refunded (also mends a row left manual because
 *               the first call's answer was lost).
 *   FAILED    → back to manual_refund_pending, owner alerted.
 *   anything else → nothing to do yet.
 */
async function settleReturnRefundEvent(supabase, refundMerchantId, state, deps = {}, payload = null) {
  const alert = deps.ownerAlert || ownerAlert;
  const ref = String(refundMerchantId || '').trim();
  if (!ref) return null;
  const { data: ret, error } = await supabase.from('return_requests')
    .select('id, order_display_id, order_id, refund_status, refund_amount_paise, items')
    .eq('refund_ref', ref).maybeSingle();
  if (error || !ret) return null;
  const oid = ret.order_display_id || ret.order_id;
  const st = String(state || '').toUpperCase();
  if (['COMPLETED', 'SUCCESS', 'CONFIRMED'].includes(st)) {
    if (ret.refund_status !== 'refunded') {
      await supabase.from('return_requests').update({ refund_status: 'refunded', refunded_at: new Date().toISOString() }).eq('id', ret.id);
    }
    const utr = await returnRefundCompleted(supabase, ret, ref, payload, deps).catch(() => null);
    return { return_refund: oid, refund_status: 'refunded', refund_utr: utr || null };
  }
  if (['FAILED', 'DECLINED'].includes(st)) {
    if (ret.refund_status === 'refunded') {
      await supabase.from('return_requests').update({ refund_status: 'manual_refund_pending' }).eq('id', ret.id);
      await alert(`⚠️ PhonePe FAILED the return refund ${ref}\nOrder: ${oid}\nAmount: ₹${Math.round((Number(ret.refund_amount_paise) || 0) / 100)}\nRetry from admin → Returns.`);
    }
    return { return_refund: oid, refund_status: 'manual_refund_pending' };
  }
  return { return_refund: oid, refund_status: ret.refund_status, pending: true };
}

/**
 * A return refund PhonePe has COMPLETED. The bank UTR is kept on the ORDER
 * (refund_utr / phonepe_refund_id), where the admin, the WhatsApp bot and the
 * refund emails already look for it, and the customer is told once, quoting
 * it (sendRefundInitiated, deduped on orders.refund_notified_at). The order's
 * status is not touched. Returns the UTR, or null (card refunds have none).
 */
async function returnRefundCompleted(supabase, ret, ref, payload, deps = {}) {
  const status = deps.getRefundStatus || getRefundStatus;
  const notify = deps.sendRefundInitiated || sendRefundInitiated;
  let utr = payload ? refundUtrFrom(payload) : null;
  let gatewayId = payload?.refundId || null;
  if (!utr) {
    try {
      const st = await status(ref);
      if (st && st.state === 'COMPLETED') { utr = refundUtrFrom(st.data); gatewayId = gatewayId || st.data?.refundId || null; }
    } catch (_) {}
  }
  const { data: order } = await supabase.from('orders').select('*').eq('id', ret.order_id).maybeSingle();
  if (!order) return utr;
  const patch = {};
  if (utr && !order.refund_utr) patch.refund_utr = utr;
  if (gatewayId && !order.phonepe_refund_id) patch.phonepe_refund_id = gatewayId;
  if (Object.keys(patch).length) {
    const { error } = await supabase.from('orders').update(patch).eq('id', order.id);
    if (!error) Object.assign(order, patch);
  }
  if (!order.refund_notified_at) {
    const items = (Array.isArray(ret.items) ? ret.items : []).map(i => ({ title: i.title, qty: i.qty }));
    await notify(order, Number(ret.refund_amount_paise) || 0, {
      supabase, state: 'COMPLETED', refundRef: order.refund_utr || utr || gatewayId || undefined, items,
    }).catch(() => {});
  }
  return order.refund_utr || utr;
}

/**
 * Hourly catch-up (return-tracking-scheduled), no money moved:
 *   1. Returns refunded through PhonePe in the last 14 days whose customer was
 *      never told, or whose UTR never arrived: ask PhonePe and settle them.
 *   2. Returns still waiting for a manual refund whose ORDER was refunded in
 *      full by another path (the order-row refund button): close them, so the
 *      Returns tab stops offering a second refund.
 */
async function syncReturnRefunds(supabase, deps = {}) {
  const status = deps.getRefundStatus || getRefundStatus;
  const out = { checked: 0, completed: [], failed: [], closed: [], errors: [] };
  const since = new Date(Date.now() - 14 * 86400000).toISOString();

  const { data: paidRows, error: e1 } = await supabase.from('return_requests')
    .select('id, order_id, order_display_id, refund_ref')
    .eq('refund_status', 'refunded').like('refund_ref', 'REFUND-%').gte('refunded_at', since);
  if (e1) out.errors.push(e1.message);
  for (const r of paidRows || []) {
    const { data: o } = await supabase.from('orders').select('refund_utr, refund_notified_at, razorpay_payment_id').eq('id', r.order_id).maybeSingle();
    if (!o || String(o.razorpay_payment_id || '').startsWith('pay_')) continue;
    if (o.refund_notified_at && o.refund_utr) continue;
    out.checked++;
    try {
      const st = await status(r.refund_ref);
      if (st.state === 'COMPLETED') {
        const res = await settleReturnRefundEvent(supabase, r.refund_ref, 'COMPLETED', deps, st.data);
        out.completed.push(`${r.order_display_id}${res?.refund_utr ? ' UTR ' + res.refund_utr : ''}`);
      } else if (st.state === 'FAILED') {
        await settleReturnRefundEvent(supabase, r.refund_ref, 'FAILED', deps, st.data);
        out.failed.push(r.order_display_id);
      }
    } catch (e) { out.errors.push(`${r.order_display_id}: ${e.message}`); }
  }

  const { data: waiting, error: e2 } = await supabase.from('return_requests')
    .select('id, order_id, order_display_id')
    .eq('refund_status', 'manual_refund_pending').eq('payment_type', 'prepaid').eq('refund_method', 'original');
  if (e2) out.errors.push(e2.message);
  for (const r of waiting || []) {
    const { data: o } = await supabase.from('orders').select('status, refund_state, refund_id, refund_updated_at').eq('id', r.order_id).maybeSingle();
    if (!o || o.status !== 'refunded' || o.refund_state !== 'COMPLETED') continue;
    const { error } = await supabase.from('return_requests').update({
      refund_status: 'refunded', refund_ref: o.refund_id || null, refunded_at: o.refund_updated_at || new Date().toISOString(),
    }).eq('id', r.id).eq('refund_status', 'manual_refund_pending');
    if (error) out.errors.push(`${r.order_display_id}: ${error.message}`); else out.closed.push(r.order_display_id);
  }
  return out;
}

module.exports = { handleReturnAwbDelivered, payReturnByPhonePe, settleReturnRefundEvent, syncReturnRefunds, returnRefundCompleted };
