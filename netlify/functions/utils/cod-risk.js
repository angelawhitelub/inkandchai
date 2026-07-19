/**
 * COD risk gate — block Cash on Delivery (and partial-COD) for customers who
 * previously REFUSED a cash-on-delivery parcel (it went RTO = Return To Origin).
 * They never paid and never accepted the box, so we only let them order again
 * with full prepaid (Razorpay / PhonePe).
 *
 * A past order counts against a customer when BOTH are true:
 *   • status = 'rto'  (courier returned it to us), and
 *   • it had a cash-on-delivery component:
 *       - pure COD      → no razorpay_payment_id, OR
 *       - partial COD   → cart_items[0]._payment.mode === 'partial_cod'
 *   (Fully-prepaid RTOs are excluded — that customer already paid and was
 *    refunded, so they aren't a cash-refusal risk.)
 *
 * Customers are matched by phone (last 10 digits) OR the email used at checkout.
 * Read-only; never throws — on any error it fails OPEN (does not block) so a
 * transient DB hiccup can never stop a legitimate customer from checking out.
 */

function last10(s) { return String(s || '').replace(/\D/g, '').slice(-10); }

async function codBlockedForCustomer(supabase, { phone, email } = {}) {
  const l10 = last10(phone);
  const em  = String(email || '').trim().toLowerCase();

  const ors = [];
  if (l10.length === 10) ors.push(`customer_phone.ilike.%${l10}`);
  if (em && /^[^\s,]+@[^\s,]+$/.test(em)) ors.push(`customer_email.ilike.${em}`);
  if (!ors.length) return { blocked: false, rtoCount: 0 };

  try {
    const { data, error } = await supabase
      .from('orders')
      .select('razorpay_order_id, razorpay_payment_id, cart_items, created_at')
      .eq('status', 'rto')
      .or(ors.join(','))
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) { console.error('[cod-risk] query error (failing open):', error.message); return { blocked: false, rtoCount: 0, error: error.message }; }

    const codRtos = (data || []).filter(o => {
      const paid    = o.razorpay_payment_id;                                        // fully/partly paid online
      const partial = Array.isArray(o.cart_items) && o.cart_items[0]?._payment?.mode === 'partial_cod';
      return !paid || partial;   // had a cash-on-delivery component they refused
    });

    return {
      blocked:  codRtos.length > 0,
      rtoCount: codRtos.length,
      lastOrderId: codRtos[0]?.razorpay_order_id || null,
    };
  } catch (e) {
    console.error('[cod-risk] exception (failing open):', e.message);
    return { blocked: false, rtoCount: 0, error: e.message };
  }
}

// Shared customer-facing copy so every surface says the same thing.
const COD_BLOCKED_MESSAGE =
  'Cash on Delivery isn’t available for this phone/email because a previous COD order came back undelivered. ' +
  'Please place this order with online payment (UPI / card / net-banking) — it’s quick and fully secure.';

module.exports = { codBlockedForCustomer, COD_BLOCKED_MESSAGE, last10 };
