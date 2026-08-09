/**
 * Netlify Function: cod-order
 * POST /.netlify/functions/cod-order
 * Saves COD order to Supabase + sends email notification via Resend.
 */

const { createClient } = require('@supabase/supabase-js');
const { sendWhatsApp } = require('./utils/whatsapp');
const { sendEmail }    = require('./utils/email');
const { pushOrderToShiprocket } = require('./utils/shiprocket');
const { pushOrderToNimbusPost } = require('./utils/nimbuspost-import');
const { resolveCartPrices, makeOrderId, cartHasNoCod } = require('./utils/pricing');
const { codBlockedForCustomer, COD_BLOCKED_MESSAGE } = require('./utils/cod-risk');
const { pincodeRejection } = require('./utils/pincode-valid');
const { findShippingRestriction } = require('./utils/shipping-restrictions');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Send email via Resend (with auto-fallback to onboarding@resend.dev) ───

function cartTable(cart, shippingFee) {
  const rows = cart.map(i => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;">${i.title}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;text-align:center;">${i.qty}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;text-align:right;color:#c9a84c;">₹${(i.price*i.qty).toLocaleString('en-IN')}</td>
    </tr>`).join('');
  const subtotal = cart.reduce((s,i)=>s+i.price*i.qty,0);
  const ship = (typeof shippingFee === 'number') ? shippingFee : (subtotal >= 499 ? 0 : 40);
  const total = subtotal + ship;
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
        <tr style="border-top:2px solid #2a2a2a;">
          <td colspan="2" style="padding:10px 12px;font-weight:500;color:#f0e8d8;">Total</td>
          <td style="padding:10px 12px;text-align:right;font-size:18px;color:#c9a84c;font-weight:600;">₹${total.toLocaleString('en-IN')}</td>
        </tr>
      </tfoot>
    </table>`;
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
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { cart: rawCart, customer, user_id } = body;
  if (!Array.isArray(rawCart) || !rawCart.length || !customer?.phone) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing cart or phone' }) };
  }

  // Reject junk pincodes (123456 …) AND pincodes India Post has no record of.
  // The browser checks this too, but that check is a 500ms debounce the
  // customer can out-click — this is the gate that decides. Fails open on a
  // missing pincode or an unreachable lookup.
  {
    const bad = await pincodeRejection(customer);
    if (bad) return { statusCode: 400, headers: CORS, body: JSON.stringify(bad) };
  }

  // Shipping rules — must match cart.js + checkout. Calculate server-side
  // defensively rather than trusting client input. Prices come from the
  // catalogue, NEVER from cart items (the browser is hostile).
  const FREE_SHIPPING_THRESHOLD = 499;
  const SHIPPING_FEE = 40;
  const COD_HANDLING_FEE = 20;            // matches generate_site.py CHECKOUT_HTML
  const COD_FEE_WAIVER_THRESHOLD = 999;   // fee waived on subtotal >= ₹999
  const _sbForPrice = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const priced = await resolveCartPrices(rawCart, _sbForPrice);
  if (!priced.cart.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No catalogue items in cart' }) };
  }
  const cart = priced.cart;
  const shippingRestriction = findShippingRestriction(cart, customer || {});
  if (shippingRestriction.blocked) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify(shippingRestriction) };
  }

  // Server-side COD guard: the full crossword.in catalogue import disables COD.
  // Reject even if the client UI was bypassed — steer to partial COD / prepaid.
  if (cartHasNoCod(cart)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({
      error: 'Cash on Delivery is not available for one or more titles in your cart. Please choose Partial COD (pay 10% now) or prepaid checkout.',
      code: 'cod_disabled',
    }) };
  }

  // RTO risk guard: customers who previously refused a COD parcel (it went RTO)
  // can't use COD again — steer them to prepaid. Enforced here so a bypassed UI
  // still can't place a COD order. Fails open on any DB error.
  const codRisk = await codBlockedForCustomer(_sbForPrice, { phone: customer.phone, email: customer.email });
  if (codRisk.blocked) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({
      error: COD_BLOCKED_MESSAGE,
      code: 'cod_blocked_rto',
    }) };
  }

  // Order ID — IC-CW-... for Crossword-migrated genuine-tag carts, IC-... otherwise.
  const orderId = await makeOrderId('IC', cart);
  const subtotal = priced.subtotal;
  const shipping = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE;
  const codFee   = subtotal >= COD_FEE_WAIVER_THRESHOLD ? 0 : COD_HANDLING_FEE;
  const total    = subtotal + shipping + codFee;

  // ── 1. Save to Supabase (non-fatal — emails still send even if DB is down) ──
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // ── Idempotency guard ──────────────────────────────────────────────────────
    // COD has no payment id, so a double-submit / retry would create a duplicate
    // order. Skip if an identical COD order (same phone + amount) was just placed.
    const amountPaiseVal = Math.round(total * 100);
    // High-value COD (> ₹999) must be confirmed by the customer over WhatsApp
    // before we ship it — cuts RTO losses. It stays "awaiting confirmation" until
    // they tap Confirm/Cancel on the WhatsApp template.
    const needsConfirm = total > 999;
    const initialStatus = needsConfirm ? 'cod_awaiting_confirmation' : 'cod_pending';
    const dupeWindow = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: recentDupe } = await supabase
      .from('orders')
      .select('razorpay_order_id')
      .eq('customer_phone', customer.phone)
      .eq('amount_paise', amountPaiseVal)
      .in('status', ['cod_pending', 'cod_awaiting_confirmation'])
      .gte('created_at', dupeWindow)
      .limit(1)
      .maybeSingle();
    if (recentDupe) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, order_id: recentDupe.razorpay_order_id, deduped: true, amount: total }),
      };
    }

    const { error } = await supabase.from('orders').insert({
      razorpay_order_id:   orderId,
      razorpay_payment_id: null,
      amount_paise:        amountPaiseVal,
      status:              initialStatus,
      customer_name:       customer.name    || '',
      customer_email:      customer.email   || '',
      customer_phone:      customer.phone,
      customer_address:    customer.address || '',
      cart_items:          cart,
      user_id:             user_id || null,
    });
    if (error) console.error('Supabase error (non-fatal):', error.message);

    // ── Auto-push to Shiprocket panel ─────────────────────────────────────
    // Skip for orders awaiting WhatsApp confirmation — don't ship until confirmed.
    if (!needsConfirm) pushOrderToShiprocket({
      inkOrderId:      orderId,
      customerName:    customer.name    || '',
      customerEmail:   customer.email   || '',
      customerPhone:   customer.phone   || '',
      customerAddress: customer.address || '',
      cartItems:       cart,
      amountPaise:     Math.round(total * 100),
      status:          'cod_pending',
      createdAt:       new Date().toISOString(),
    }).catch(e => console.error('[Shiprocket] push failed (non-fatal):', e.message));

    // ── Auto-push to NimbusPost panel (no AWB) ─────────────────────────────
    // Fire-and-forget; admin still has a manual bulk "Push to NimbusPost Panel".
    if (!needsConfirm) pushOrderToNimbusPost({
      razorpay_order_id: orderId,
      status: 'cod_pending',
      customer_name: customer.name || '',
      customer_phone: customer.phone || '',
      customer_address: customer.address || '',
      amount_paise: Math.round(total * 100),
      cart_items: cart,
    })
      // Stamp the row so a later manual bulk push never re-pushes this order
      // (best-effort; needs orders_nimbus_pushed_at.sql).
      .then(() => supabase.from('orders').update({ nimbus_pushed_at: new Date().toISOString() }).eq('razorpay_order_id', orderId))
      .catch(e => console.error('[NimbusPost] auto-push failed (non-fatal):', e.message));

  } catch (err) {
    console.error('Supabase error (non-fatal):', err.message);
  }

  // ── 2. Email YOU (store owner) ────────────────────────────────────────────
  const ownerEmail = process.env.STORE_OWNER_EMAIL;
  if (ownerEmail) {
    await sendEmail({
      to: ownerEmail,
      subject: `🚚 New COD Order ${orderId} — ₹${total.toLocaleString('en-IN')}`,
      html: emailBase(`
        <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">New Cash on Delivery Order</h2>
        <p style="color:#a09080;margin-bottom:16px;">Order ID: <strong style="color:#c9a84c;">${orderId}</strong></p>
        <table style="font-size:14px;line-height:1.8;color:#f0e8d8;">
          <tr><td style="color:#a09080;padding-right:16px;">Name</td><td>${customer.name||'—'}</td></tr>
          <tr><td style="color:#a09080;padding-right:16px;">Phone</td><td>${customer.phone}</td></tr>
          <tr><td style="color:#a09080;padding-right:16px;">Email</td><td>${customer.email||'—'}</td></tr>
          <tr><td style="color:#a09080;padding-right:16px;">Address</td><td>${customer.address||'—'}</td></tr>
        </table>
        ${cartTable(cart, shipping)}
        <p style="color:#6dbf6d;font-size:13px;">💰 Collect ₹${total.toLocaleString('en-IN')} cash at delivery.</p>
      `),
    });
  }

  // ── 3. Confirmation email to CUSTOMER ─────────────────────────────────────
  if (customer.email) {
    await sendEmail({
      to: customer.email,
      subject: `Your Ink & Chai order is confirmed! (${orderId})`,
      html: emailBase(`
        <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">Order Confirmed 📚</h2>
        <p style="color:#a09080;line-height:1.8;margin-bottom:16px;">
          Hi ${customer.name?.split(' ')[0]||'there'}, your books are on their way!<br/>
          You'll pay <strong style="color:#c9a84c;">₹${total.toLocaleString('en-IN')}</strong> in cash when they arrive.
        </p>
        ${cartTable(cart, shipping)}
        <p style="color:#a09080;font-size:13px;line-height:1.8;">
          <strong style="color:#f0e8d8;">Delivery address:</strong><br/>${customer.address||'—'}
        </p>
        <p style="margin-top:16px;color:#7a6330;font-size:12px;">Order ID: <strong style="color:#c9a84c;">${orderId}</strong></p>
        <div style="margin-top:20px;padding:14px 16px;background:#1c1916;border-left:3px solid #c9a84c;">
          <p style="color:#f0e8d8;font-size:13px;margin:0 0 10px;">📦 Track your order any time</p>
          <a href="https://inkandchai.in/track/?id=${encodeURIComponent(orderId)}&q=${encodeURIComponent(customer.email||customer.phone)}" style="display:inline-block;background:#c9a84c;color:#0d0b08;padding:10px 22px;text-decoration:none;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:600;">Track Order →</a>
          <p style="color:#a09080;font-size:11px;line-height:1.7;margin:10px 0 0;">
            We'll email you again as soon as the courier picks up your books, with a tracking number you can use on the courier's site.
          </p>
        </div>
      `),
    });
  }

  // ── 4. WhatsApp to CUSTOMER ──────────────────────────────────────────────
  if (customer.phone) {
    const firstName = (customer.name || 'there').split(' ')[0];
    const bookList = Array.isArray(cart) && cart.length
      ? cart.map(i => i.title || i.name || '').filter(Boolean).join(', ').slice(0, 200)
      : 'your books';
    if (total > 999) {
      // High-value COD — send the Confirm/Cancel button template. The order is
      // held as 'cod_awaiting_confirmation' until they tap a button (handled in
      // whatsapp-bot.js). Template params: name, amount, order id, book(s).
      await sendWhatsApp({
        to: customer.phone,
        template: 'cod_confirm',
        params: [firstName, `₹${total.toLocaleString('en-IN')}`, orderId, bookList],
      });
    } else {
      const addrShort = (customer.address || '').slice(0, 80);
      await sendWhatsApp({
        to: customer.phone,
        template: 'order_confirmed',
        params: [firstName, orderId, `₹${total.toLocaleString('en-IN')} (COD)`, addrShort, bookList],
      });
    }
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ success: true, order_id: orderId, amount: total }),
  };
};
