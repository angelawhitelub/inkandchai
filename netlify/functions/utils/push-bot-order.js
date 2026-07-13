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
const { sendWhatsApp, sendText } = require('./whatsapp');
const { priceBooksList } = require('./book-lookup');

// The bot stores multiple books as a single comma-separated string in
// `req.books` (see whatsapp-bot.js — the `books` tool field is documented as
// "comma-separated"). Storing that as ONE cart item makes NimbusPost print all
// titles jammed into a single product row. Split it into one cart item per book
// — same delimiter the pricing lookup uses — so each title ships on its own row.
async function buildCartFromBooks(booksStr, amountRupees) {
  const raw = String(booksStr || '').trim();
  if (!raw) return [{ title: 'Book', qty: 1, price: amountRupees }];
  const titles = raw.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
  if (titles.length <= 1) return [{ title: raw, qty: 1, price: amountRupees }];

  // Per-book prices: priceBooksList splits with the SAME regex, so its items are
  // index-aligned with `titles`. Best-effort — fall back to an even split.
  let priced = null;
  try { priced = await priceBooksList(raw); } catch (e) { console.error('buildCartFromBooks price:', e.message); }
  const evenPrice = Math.max(1, Math.round(amountRupees / titles.length));
  const items = Array.isArray(priced?.items) && priced.items.length === titles.length ? priced.items : null;
  return titles.map((t, i) => {
    const p = items && Number(items[i]?.price) > 0 ? Math.round(Number(items[i].price)) : evenPrice;
    return { title: t, qty: 1, price: p };
  });
}

// Order-confirmation WhatsApp to the customer AND the store owner, fired the
// moment a book request is confirmed into a real order (both COD and prepaid).
// Best-effort — never blocks or fails the push.
async function notifyOrderConfirmed({ orderId, phone10, customerName, address, books, amountRupees, paymentKind }) {
  const firstName = String(customerName || 'there').split(' ')[0];
  const bookList  = String(books || 'your books').slice(0, 200);
  const modeLabel = paymentKind === 'online_paid' ? 'Paid'
                  : paymentKind === 'prepaid_pending' ? 'Prepaid'
                  : 'COD';
  const amtLabel  = `₹${Number(amountRupees).toLocaleString('en-IN')} (${modeLabel})`;

  // Customer — reuse the same approved template the website order flow uses.
  if (phone10) {
    try {
      await sendWhatsApp({
        to: phone10,
        template: 'order_confirmed',
        params: [firstName, orderId, amtLabel, String(address || '').slice(0, 80), bookList],
      });
    } catch (e) { console.error('[push-bot-order] customer confirm WA:', e.message); }
  }

  // Owner — free-form text (owner chats with the bot, so within the 24h window).
  const ownerPhone = process.env.STORE_OWNER_PHONE;
  if (ownerPhone) {
    try {
      await sendText(ownerPhone,
        `✅ Order confirmed (WhatsApp book request)\n🆔 ${orderId}\n👤 ${customerName || '—'}\n📞 ${phone10 || '—'}\n📚 ${bookList}\n📍 ${String(address || '—').slice(0, 120)}\n💰 ${amtLabel}\n\nPushed to Orders — ship it from the Orders tab.`);
    } catch (e) { console.error('[push-bot-order] owner confirm WA:', e.message); }
  }
}

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

  // Do NOT create an Orders row for an UNPAID prepaid request. Only a payment
  // LINK was generated — the customer hasn't paid. Pushing it anyway lands a
  // 'confirmed' order in the Orders tab that counts toward paid revenue and gets
  // sent to the courier, i.e. it looks/acts "paid" when no money was received.
  // Prepaid orders move to Orders automatically once the link is paid (the
  // follow-up poller re-invokes this with the payment confirmed). To ship now,
  // the admin can switch the request/order to COD.
  if (paymentMode === 'prepaid' && !paidConfirmed) {
    return {
      ok: false,
      code: 409,
      error: 'Customer has not paid the prepaid link yet — it can\'t go to Orders. It will move there automatically once the payment is received (or switch it to COD to ship now).',
      payment_kind: 'unpaid_prepaid',
    };
  }

  const orderId    = mintOrderId(req.order_id);
  const phone10    = String(req.customer_phone || '').replace(/\D/g, '').slice(-10);
  const amountPaise = amountRupees * 100;
  const cart = await buildCartFromBooks(req.books, amountRupees);

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

  // Confirm to customer + owner on WhatsApp (COD and prepaid alike). Awaited so
  // it runs before the function returns, but its own errors never throw.
  await notifyOrderConfirmed({
    orderId, phone10, customerName: req.customer_name, address: req.address,
    books: req.books, amountRupees, paymentKind,
  });

  return { ok: true, order_id: orderId, status, amount: amountRupees, payment_kind: paymentKind };
}

module.exports = { pushBotOrder };
