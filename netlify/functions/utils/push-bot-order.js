/**
 * Shared: convert a WhatsApp bot book-order request (bot_order_requests row)
 * into a REAL order in the `orders` table.
 *
 * Used by:
 *   - push-book-request.js       (admin clicks "Push to Orders")
 *   - bot-order-followup-*.js    (auto-push once a prepaid link is paid)
 *
 * The historical bug this fixes: prepaid requests were inserted with
 * razorpay_payment_id = null, and the admin panel derives "COD vs Online"
 * from the presence of a payment id — so a PAID prepaid order showed as COD.
 * Here, a prepaid request that Razorpay reports as paid is written with the
 * real pay_… id + status 'paid', so it correctly reads as an online order.
 *
 * Never throws for the NimbusPost push (best-effort); DB errors do throw so the
 * caller can surface them.
 */

const { pushOrderToNimbusPost } = require('./nimbuspost-import');
const { fetchPaymentLinkStatus } = require('./razorpay-payment-link');

function mintOrderId(existing) {
  if (existing) return existing;
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randPart = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `IC-W-${datePart}-${randPart}`;
}

/**
 * @param {object} supabase  an initialised supabase-js client (service key)
 * @param {object} req       the bot_order_requests row (needs customer_name,
 *                           customer_phone, address, books, order_id,
 *                           amount_paise, payment_mode, payment_status,
 *                           razorpay_payment_link_id)
 * @param {object} [opts]
 * @param {number} [opts.amountRupees]  override amount; else req.amount_paise
 * @param {'cod'|'prepaid'} [opts.paymentMode]  override; else req.payment_mode
 * @returns {Promise<{ok:boolean, order_id?:string, status?:string, amount?:number, payment_kind?:string, error?:string, code?:number}>}
 */
async function pushBotOrder(supabase, req, opts = {}) {
  if (!req) return { ok: false, error: 'No request row', code: 404 };
  if (req.order_pushed_id) {
    return { ok: false, error: `Already pushed as ${req.order_pushed_id}.`, code: 400, order_id: req.order_pushed_id };
  }

  const paymentMode = (opts.paymentMode || req.payment_mode) === 'prepaid' ? 'prepaid' : 'cod';
  let amountRupees = Math.round(Number(opts.amountRupees) || 0);
  if (!amountRupees && req.amount_paise) amountRupees = Math.round(Number(req.amount_paise) / 100);
  if (!amountRupees || amountRupees <= 0) {
    return { ok: false, error: 'Provide a valid amount (rupees).', code: 400 };
  }

  // For prepaid: check whether Razorpay has actually captured the payment, and
  // grab the real payment id so the order reads as "online / paid".
  let razorpayPaymentId = null;
  let paidConfirmed = false;
  if (paymentMode === 'prepaid') {
    if (req.razorpay_payment_link_id) {
      try {
        const link = await fetchPaymentLinkStatus(req.razorpay_payment_link_id);
        if (link.status === 'paid') { paidConfirmed = true; razorpayPaymentId = link.paymentId || `plink:${req.razorpay_payment_link_id}`; }
      } catch (e) {
        // Fall back to the request's own flag if the live check fails.
        console.error('[push-bot-order] link status check failed:', e.message);
      }
    }
    if (!paidConfirmed && req.payment_status === 'paid') {
      paidConfirmed = true;
      razorpayPaymentId = razorpayPaymentId || (req.razorpay_payment_link_id ? `plink:${req.razorpay_payment_link_id}` : `prepaid:${req.order_id || 'bot'}`);
    }
  }

  const orderId    = mintOrderId(req.order_id);
  const phone10    = String(req.customer_phone || '').replace(/\D/g, '').slice(-10);
  const amountPaise = amountRupees * 100;
  const cart = [{ title: req.books || 'Book', qty: 1, price: amountRupees }];

  // Status + payment markers by kind:
  //   cod              → cod_pending, no payment_status
  //   prepaid + paid    → paid,       payment_status 'paid', real payment id
  //   prepaid + unpaid  → confirmed,  payment_status 'prepaid_pending' (awaiting)
  let status, paymentStatus, paidAt = null, paymentKind;
  if (paymentMode === 'cod') {
    status = 'cod_pending'; paymentStatus = null; paymentKind = 'cod';
  } else if (paidConfirmed) {
    status = 'paid'; paymentStatus = 'paid'; paidAt = new Date().toISOString(); paymentKind = 'online_paid';
  } else {
    status = 'confirmed'; paymentStatus = 'prepaid_pending'; paymentKind = 'prepaid_pending';
  }

  const row = {
    razorpay_order_id:   orderId,
    razorpay_payment_id: razorpayPaymentId,
    amount_paise:        amountPaise,
    status,
    customer_name:       req.customer_name || '',
    customer_email:      '',
    customer_phone:      phone10,
    customer_address:    req.address || '',
    cart_items:          cart,
  };
  // payment_status / paid_at are newer columns; include only when set so a
  // missing column doesn't break the insert on older schemas.
  const { error: insErr } = await supabase.from('orders').insert(
    paymentStatus ? { ...row, payment_status: paymentStatus, ...(paidAt ? { paid_at: paidAt } : {}) } : row
  );
  if (insErr) {
    if (insErr.code === '23505') return { ok: false, error: `Order ${orderId} already exists.`, code: 409, order_id: orderId };
    // Retry once without the newer columns in case that was the failure cause.
    if (paymentStatus) {
      const { error: retryErr } = await supabase.from('orders').insert(row);
      if (retryErr) throw retryErr;
    } else {
      throw insErr;
    }
  }

  await supabase.from('bot_order_requests')
    .update({ status: 'ordered', order_pushed_id: orderId })
    .eq('id', req.id);

  pushOrderToNimbusPost({
    razorpay_order_id: orderId,
    status,
    customer_name: req.customer_name || '',
    customer_phone: phone10,
    customer_address: req.address || '',
    amount_paise: amountPaise,
    cart_items: cart,
  }).catch(e => console.error('[push-bot-order] NimbusPost push failed (non-fatal):', e.message));

  return { ok: true, order_id: orderId, status, amount: amountRupees, payment_kind: paymentKind };
}

module.exports = { pushBotOrder };
