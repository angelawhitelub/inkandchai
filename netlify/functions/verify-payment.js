/**
 * Netlify Function: verify-payment
 * POST /.netlify/functions/verify-payment
 * Verifies Razorpay signature, saves order to Supabase, sends email notifications.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { sendWhatsApp } = require('./utils/whatsapp');
const { sendEmail }    = require('./utils/email');
const { pushOrderToShiprocket } = require('./utils/shiprocket');
const { generateCardForOrder, redeemScratchCardForOrder } = require('./utils/scratch-cards');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Send email via Resend (with auto-fallback to onboarding@resend.dev) ───

function cartTable(cart, shippingFee, discount = 0, coupon = '') {
  const rows = cart.map(i => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;">${i.title}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;text-align:center;">${i.qty}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;text-align:right;color:#c9a84c;">₹${(i.price*i.qty).toLocaleString('en-IN')}</td>
    </tr>`).join('');
  const subtotal = cart.reduce((s,i)=>s+i.price*i.qty,0);
  const ship = (typeof shippingFee === 'number') ? shippingFee : (subtotal >= 499 ? 0 : 40);
  const safeDiscount = Math.max(0, Number(discount) || 0);
  const total = Math.max(1, subtotal + ship - safeDiscount);
  return `
    <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
      <thead>
        <tr style="background:#1c1916;">
          <th style="padding:8px 12px;text-align:left;color:#c9a84c;font-weight:500;">Book</th>
          <th style="padding:8px 12px;text-align:center;color:#c9a84c;font-weight:500;">Qty</th>
          <th style="padding:8px 12px;text-align:right;color:#c9a84c;font-weight:500;">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="2" style="padding:8px 12px;color:#a09080;">Subtotal</td>
          <td style="padding:8px 12px;text-align:right;color:#f0e8d8;">₹${subtotal.toLocaleString('en-IN')}</td>
        </tr>
        <tr>
          <td colspan="2" style="padding:8px 12px;color:#a09080;">Shipping (Delhivery)</td>
          <td style="padding:8px 12px;text-align:right;color:${ship === 0 ? '#6dbf6d' : '#f0e8d8'};">${ship === 0 ? 'FREE' : '₹' + ship}</td>
        </tr>
        ${safeDiscount > 0 ? `<tr>
          <td colspan="2" style="padding:8px 12px;color:#a09080;">Coupon ${coupon ? `(${coupon})` : ''}</td>
          <td style="padding:8px 12px;text-align:right;color:#6dbf6d;">- ₹${safeDiscount.toLocaleString('en-IN')}</td>
        </tr>` : ''}
        <tr style="border-top:2px solid #2a2a2a;">
          <td colspan="2" style="padding:10px 12px;font-weight:500;color:#f0e8d8;">Total (Online Payment)</td>
          <td style="padding:10px 12px;text-align:right;font-size:18px;color:#c9a84c;font-weight:600;">₹${total.toLocaleString('en-IN')}</td>
        </tr>
      </tfoot>
    </table>`;
}

function paymentMeta(cart) {
  const first = Array.isArray(cart) ? cart[0] : null;
  return first && typeof first._payment === 'object' ? first._payment : {};
}

function emailBase(content) {
  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">inkandchai.in</p>
      ${content}
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai · inkandchai.in · For support, reply to this email.</p>
    </div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    cart,
    customer,
    amount,
    shipping,
    coupon,
    discount,
    payment_mode,
  } = body;
  // Re-derive shipping defensively if not provided by client
  const subtotalRupees = cart ? cart.reduce((s,i)=>s+i.price*i.qty,0) : 0;
  const shipFee = (typeof shipping === 'number')
    ? shipping
    : (subtotalRupees >= 499 ? 0 : 40);

  // ── 1. Verify signature ───────────────────────────────────────────────────
  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSig !== razorpay_signature) {
    console.error('Signature mismatch');
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid signature' }) };
  }

  // ── 2. Save to Supabase ───────────────────────────────────────────────────
  const paidTotal = Math.round((Number(amount) || 0) / 100);
  const discountRupees = Math.max(0, Number(discount) || 0);
  const couponCode = String(coupon || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const meta = paymentMeta(cart);
  const isPartial = payment_mode === 'partial_cod' || meta.mode === 'partial_cod';
  const computedFullTotal = Math.max(1, subtotalRupees + shipFee);
  if (isPartial && cart?.[0]) {
    cart[0]._payment = {
      mode: 'partial_cod',
      full_total: computedFullTotal,
      deposit: paidTotal,
      balance: Math.max(0, computedFullTotal - paidTotal),
      rate: 0.10,
    };
  }
  const balanceDue = isPartial ? Math.max(0, computedFullTotal - paidTotal) : 0;
  const fullTotal = isPartial ? computedFullTotal : paidTotal;

  // Generate a consistent IC- order ID for Razorpay orders (same format as PhonePe/COD)
  const now = new Date();
  const datePart = now.toISOString().slice(0,10).replace(/-/g,'');
  const randPart = Math.random().toString(36).substring(2,7).toUpperCase();
  const inkOrderId = `IC-${datePart}-${randPart}`;

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // ── Idempotency guard ──────────────────────────────────────────────────────
    // The Razorpay webhook fires independently and may have already created this
    // order (e.g. if the browser callback was slow). Never insert a SECOND order
    // for the same payment — update the existing one with the real browser-side
    // customer details (the webhook only has placeholder data like void@razorpay.com)
    // and return. This is what was causing duplicate orders.
    const { data: existingOrder } = await supabase
      .from('orders')
      .select('id, razorpay_order_id')
      .eq('razorpay_payment_id', razorpay_payment_id)
      .maybeSingle();
    if (existingOrder) {
      await supabase.from('orders').update({
        status:           isPartial ? 'partial_cod_pending' : 'paid',
        customer_name:    customer?.name    || '',
        customer_email:   customer?.email   || '',
        customer_phone:   customer?.phone   || '',
        customer_address: customer?.address || '',
        cart_items:       cart,
      }).eq('id', existingOrder.id);
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, order_id: existingOrder.razorpay_order_id, payment_id: razorpay_payment_id, deduped: true }),
      };
    }

    const { error } = await supabase.from('orders').insert({
      razorpay_order_id:   inkOrderId,          // IC- format — consistent across all payment methods
      razorpay_payment_id: razorpay_payment_id, // pay_XXXXX — actual Razorpay payment ID (for refunds)
      amount_paise:     amount,
      status:           isPartial ? 'partial_cod_pending' : 'paid',
      customer_name:    customer?.name    || '',
      customer_email:   customer?.email   || '',
      customer_phone:   customer?.phone   || '',
      customer_address: customer?.address || '',
      cart_items:       cart,
    });

    if (error) throw error;

    // ── Auto-push to Shiprocket panel ─────────────────────────────────────
    pushOrderToShiprocket({
      inkOrderId:       inkOrderId,
      customerName:     customer?.name    || '',
      customerEmail:    customer?.email   || '',
      customerPhone:    customer?.phone   || '',
      customerAddress:  customer?.address || '',
      cartItems:        cart,
      amountPaise:      amount,
      status:           isPartial ? 'partial_cod_pending' : 'paid',
      createdAt:        new Date().toISOString(),
    }).catch(e => console.error('[Shiprocket] push failed (non-fatal):', e.message));
    // Non-fatal: fire & forget — don't block the response if Shiprocket is slow

    // ── Scratch card reward — only for full prepaid orders (not partial COD) ─
    if (!isPartial) {
      generateCardForOrder(supabase, {
        razorpay_order_id: inkOrderId,
        status: 'paid',
        customer_phone: customer?.phone || '',
        customer_email: customer?.email || '',
        customer_name:  customer?.name  || '',
      }).catch(e => console.error('[ScratchCard] generate failed (non-fatal):', e.message));
    }

    // Mark any scratch-card coupon used on this order as redeemed
    if (coupon) {
      redeemScratchCardForOrder(supabase, coupon, inkOrderId)
        .catch(e => console.error('[ScratchCard] redeem failed (non-fatal):', e.message));
    }

  } catch (err) {
    console.error('Supabase save error:', err);
    // Payment was valid even if DB save fails — still send emails and return success
  }

  // ── 3. Email YOU (store owner) ────────────────────────────────────────────
  const ownerEmail = process.env.STORE_OWNER_EMAIL;
  if (ownerEmail && cart?.length) {
    await sendEmail({
      to: ownerEmail,
      subject: isPartial
        ? `💰 Partial COD Order — ₹${paidTotal.toLocaleString('en-IN')} paid · collect ₹${balanceDue.toLocaleString('en-IN')}`
        : `💳 New Online Order — ₹${paidTotal.toLocaleString('en-IN')} (${razorpay_payment_id})`,
      html: emailBase(`
        <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">${isPartial ? 'New Partial COD Order' : 'New Online Payment Received'}</h2>
        <p style="color:#a09080;margin-bottom:16px;">
          Order ID: <strong style="color:#c9a84c;">${inkOrderId}</strong><br/>
          Razorpay Payment ID: <strong style="color:#c9a84c;">${razorpay_payment_id}</strong>
        </p>
        <table style="font-size:14px;line-height:1.8;color:#f0e8d8;">
          <tr><td style="color:#a09080;padding-right:16px;">Name</td><td>${customer?.name||'—'}</td></tr>
          <tr><td style="color:#a09080;padding-right:16px;">Phone</td><td>${customer?.phone||'—'}</td></tr>
          <tr><td style="color:#a09080;padding-right:16px;">Email</td><td>${customer?.email||'—'}</td></tr>
          <tr><td style="color:#a09080;padding-right:16px;">Address</td><td>${customer?.address||'—'}</td></tr>
        </table>
        ${cartTable(cart, shipFee, discountRupees, couponCode)}
        ${isPartial ? `<p style="color:#c9a84c;font-size:13px;background:#1c1916;padding:10px 14px;">Customer paid ₹${paidTotal.toLocaleString('en-IN')} now. Collect ₹${balanceDue.toLocaleString('en-IN')} on delivery. Full order value: ₹${fullTotal.toLocaleString('en-IN')}.</p>` : `<p style="color:#6dbf6d;font-size:13px;">✅ Payment confirmed. Ready to ship!</p>`}
      `),
    });
  }

  // ── 4. Confirmation email to CUSTOMER ─────────────────────────────────────
  if (customer?.email && cart?.length) {
    await sendEmail({
      to: customer.email,
      subject: `Your Ink & Chai order is confirmed! (${razorpay_payment_id})`,
      html: emailBase(`
        <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">Order Confirmed 📚</h2>
        <p style="color:#a09080;line-height:1.8;margin-bottom:16px;">
          Hi ${customer.name?.split(' ')[0]||'there'}, your books are on their way!<br/>
          ${isPartial
            ? `We received your 10% booking payment of <strong style="color:#c9a84c;">₹${paidTotal.toLocaleString('en-IN')}</strong>. Please pay the remaining <strong style="color:#c9a84c;">₹${balanceDue.toLocaleString('en-IN')}</strong> when your books are delivered.`
            : `Your payment of <strong style="color:#c9a84c;">₹${paidTotal.toLocaleString('en-IN')}</strong> was received successfully.`}
        </p>
        ${cartTable(cart, shipFee, discountRupees, couponCode)}
        <p style="color:#a09080;font-size:13px;line-height:1.8;">
          <strong style="color:#f0e8d8;">Delivery address:</strong><br/>${customer.address||'—'}
        </p>
        <p style="margin-top:16px;color:#7a6330;font-size:12px;">Order ID: <strong style="color:#c9a84c;">${inkOrderId}</strong></p>
        <div style="margin-top:20px;padding:14px 16px;background:#1c1916;border-left:3px solid #c9a84c;">
          <p style="color:#f0e8d8;font-size:13px;margin:0 0 10px;">📦 Track your order any time</p>
          <a href="https://inkandchai.in/track/?id=${encodeURIComponent(inkOrderId)}&q=${encodeURIComponent(customer.email||customer.phone||'')}" style="display:inline-block;background:#c9a84c;color:#0d0b08;padding:10px 22px;text-decoration:none;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:600;">Track Order →</a>
          <p style="color:#a09080;font-size:11px;line-height:1.7;margin:10px 0 0;">
            We'll email you again as soon as the courier picks up your books, with the tracking number.
          </p>
        </div>
      `),
    });
  }

  // ── 5. WhatsApp confirmation to CUSTOMER ─────────────────────────────────
  if (customer?.phone) {
    const firstName = (customer.name || 'there').split(' ')[0];
    const amtDisplay = isPartial
      ? `₹${paidTotal.toLocaleString('en-IN')} (10% advance) + ₹${balanceDue.toLocaleString('en-IN')} COD`
      : `₹${paidTotal.toLocaleString('en-IN')}`;
    const addrShort = (customer.address || '').slice(0, 80);
    const bookList = Array.isArray(cart) && cart.length
      ? cart.map(i => i.title || i.name || '').filter(Boolean).join(', ').slice(0, 200)
      : 'your books';
    await sendWhatsApp({
      to: customer.phone,
      template: 'order_confirmed',
      params: [firstName, inkOrderId, amtDisplay, addrShort, bookList],
    });
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ success: true, payment_id: razorpay_payment_id }),
  };
};
