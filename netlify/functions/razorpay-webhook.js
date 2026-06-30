/**
 * Netlify Function: razorpay-webhook
 * POST /.netlify/functions/razorpay-webhook
 *
 * Handles Razorpay server-side webhook events.
 * Catches payments that were captured but whose handler() callback
 * never fired in the browser (UPI processing delays, browser closes, etc.)
 *
 * Setup in Razorpay Dashboard → Settings → Webhooks → Add:
 *   URL: https://inkandchai.in/.netlify/functions/razorpay-webhook
 *   Secret: any string → also set as RAZORPAY_WEBHOOK_SECRET in Netlify env
 *   Events: payment.captured, payment.failed
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { sendWhatsApp } = require('./utils/whatsapp');
const { sendEmail }    = require('./utils/email');
const { generateCardForOrder } = require('./utils/scratch-cards');
const { pushOrderToNimbusPost } = require('./utils/nimbuspost-import');
const { makeOrderId } = require('./utils/pricing');

const CORS = { 'Content-Type': 'application/json' };

function emailBase(content) {
  return `<div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
    <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
    <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">inkandchai.in</p>
    ${content}
    <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
    <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai · inkandchai.in</p>
  </div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  // ── Verify Razorpay webhook signature ────────────────────────────────────
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (webhookSecret) {
    const received = event.headers['x-razorpay-signature'] || '';
    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(event.body)
      .digest('hex');
    if (received !== expected) {
      console.warn('razorpay-webhook: signature mismatch');
      return { statusCode: 403, body: 'Forbidden' };
    }
  }

  let payload;
  try { payload = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: 'Bad JSON' }; }

  const event_type = payload.event;
  const payment    = payload.payload?.payment?.entity;

  console.log(`[razorpay-webhook] event=${event_type} payment_id=${payment?.id} order_id=${payment?.order_id} status=${payment?.status}`);

  // Only process captured payments
  if (event_type !== 'payment.captured' || !payment) {
    return { statusCode: 200, body: 'OK' };
  }

  const razorpay_order_id  = payment.order_id;   // order_XXXXXX
  const razorpay_payment_id = payment.id;        // pay_XXXXXX
  const amount_paise       = payment.amount;
  const customerEmail      = payment.email || payment.notes?.customer_email || '';
  const customerPhone      = payment.contact || payment.notes?.customer_phone || '';
  // notes.customer_name is set by create-order.js; also try notes.name as fallback
  const customerName       = payment.notes?.customer_name || payment.notes?.name || '';

  if (!razorpay_order_id || !razorpay_payment_id) {
    return { statusCode: 200, body: 'OK — no order/payment id' };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Check if order already exists (handler() may have already saved it) ──
  const { data: existing } = await supabase
    .from('orders')
    .select('id, razorpay_order_id, status')
    .eq('razorpay_payment_id', razorpay_payment_id)
    .maybeSingle();

  if (existing) {
    console.log(`[razorpay-webhook] Already saved as ${existing.razorpay_order_id} — skip`);
    return { statusCode: 200, body: 'OK — already exists' };
  }

  // ── Try to find the abandoned checkout data (cart, customer, etc.) ────────
  // The checkout saves to Supabase abandoned_checkouts with razorpay_order_id
  const { data: abandoned } = await supabase
    .from('abandoned_checkouts')
    .select('*')
    .eq('razorpay_order_id', razorpay_order_id)
    .maybeSingle();

  // ── Source guard (shared Razorpay account) ────────────────────────────────
  // paperbound tags its Razorpay orders with notes.source = 'paperbound' (and
  // mirrors it on the abandoned_checkout row). Skip those — they're recovered by
  // the paperbound webhook. Everything else (legacy/unset) is inkandchai's.
  const evSource = payment.notes?.source || abandoned?.source || '';
  if (evSource === 'paperbound') {
    console.log('[razorpay-webhook] paperbound order — skip (handled by paperbound webhook)');
    return { statusCode: 200, body: 'OK — other store' };
  }

  const cart     = abandoned?.cart_items || [];
  const customer = abandoned?.customer   || {};
  const name     = customer.name    || customerName   || '';
  const email    = customer.email   || customerEmail  || '';
  const phone    = customer.phone   || customerPhone  || '';
  const address  = customer.address || payment.notes?.shipping_address || '';
  // If cart is empty (no abandoned checkout), build a placeholder from notes.books
  const cartItems = cart.length > 0 ? cart : (payment.notes?.books
    ? [{ title: payment.notes.books, qty: 1, price: Math.round(amount_paise / 100) }]
    : []);

  // IC- (or IC-CW- for Crossword-migrated genuine-tag carts) order ID.
  const inkOrderId = await makeOrderId('IC', cartItems, supabase);

  // ── Save the order ────────────────────────────────────────────────────────
  const { error: saveErr } = await supabase.from('orders').insert({
    razorpay_order_id:   inkOrderId,
    razorpay_payment_id: razorpay_payment_id,
    amount_paise:        amount_paise,
    status:              'paid',
    customer_name:       name,
    customer_email:      email,
    customer_phone:      phone,
    customer_address:    address,
    cart_items:          cartItems,
  });

  if (saveErr) {
    // Unique-violation on razorpay_payment_id means the browser callback already
    // created this order. Stop here — do NOT continue to scratch card / WhatsApp,
    // or the customer would be notified twice for one order.
    if (saveErr.code === '23505') {
      console.log('[razorpay-webhook] order already exists (browser created it) — skip');
      return { statusCode: 200, body: 'OK — already exists' };
    }
    console.error('[razorpay-webhook] DB save error:', saveErr.message);
    return { statusCode: 500, body: JSON.stringify({ error: saveErr.message }) };
  }

  console.log(`[razorpay-webhook] ✅ Saved missed order: ${inkOrderId} (${razorpay_payment_id})`);

  // ── Auto-push recovered order to NimbusPost panel (no AWB) ───────────────
  pushOrderToNimbusPost({
    razorpay_order_id: inkOrderId,
    status: 'paid',
    customer_name: name || '',
    customer_phone: phone || '',
    customer_address: address || '',
    amount_paise: amount_paise,
    cart_items: cartItems,
  }).catch(e => console.error('[NimbusPost] auto-push failed (non-fatal):', e.message));

  // ── Scratch card reward (non-fatal) ──────────────────────────────────────
  generateCardForOrder(supabase, {
    razorpay_order_id: inkOrderId,
    status: 'paid',
    customer_phone: phone, customer_email: email, customer_name: name,
  }).catch(e => console.error('[ScratchCard] generate failed (non-fatal):', e.message));

  // ── Notify store owner ───────────────────────────────────────────────────
  const ownerEmail = process.env.STORE_OWNER_EMAIL;
  if (ownerEmail) {
    const amtDisplay = `₹${(amount_paise / 100).toLocaleString('en-IN')}`;
    await sendEmail({
      to: ownerEmail,
      subject: `⚡ Recovered Payment — ${inkOrderId} · ${amtDisplay}`,
      html: emailBase(`
        <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">⚡ Payment Recovered via Webhook</h2>
        <p style="color:#a09080;margin-bottom:16px;">
          This order was caught by the Razorpay webhook — the browser callback did not fire
          (customer may have closed the app or had a slow connection).<br/><br/>
          <strong style="color:#c9a84c;">Order ID:</strong> ${inkOrderId}<br/>
          <strong style="color:#c9a84c;">Payment ID:</strong> ${razorpay_payment_id}<br/>
          <strong style="color:#c9a84c;">Amount:</strong> ${amtDisplay}
        </p>
        <table style="font-size:14px;line-height:1.8;color:#f0e8d8;">
          <tr><td style="color:#a09080;padding-right:16px;">Name</td><td>${name||'—'}</td></tr>
          <tr><td style="color:#a09080;padding-right:16px;">Phone</td><td>${phone||'—'}</td></tr>
          <tr><td style="color:#a09080;padding-right:16px;">Email</td><td>${email||'—'}</td></tr>
          <tr><td style="color:#a09080;padding-right:16px;">Address</td><td>${address||'—'}</td></tr>
        </table>
        <p style="color:#6dbf6d;font-size:13px;margin-top:16px;">✅ Order is confirmed and ready to ship.</p>
      `),
    });
  }

  // ── Notify customer (WhatsApp first, email as a safety net when available) ─
  const firstName = (name || 'there').split(' ')[0];
  const amtDisplay = `₹${(amount_paise / 100).toLocaleString('en-IN')}`;
  if (phone) {
    try {
      const r = await sendWhatsApp({
        to: phone,
        template: 'order_confirmed',
        params: [
          firstName, inkOrderId, amtDisplay,
          (address || '').slice(0, 80),
          cartItems.map(i => i.title || '').filter(Boolean).join(', ').slice(0, 200) || 'your books',
        ],
      });
      console.log(`[razorpay-webhook] customer WA notify [${inkOrderId}] → ${phone}: ok`, r?.messages?.[0]?.id || '');
    } catch (e) {
      console.error(`[razorpay-webhook] customer WA notify FAILED [${inkOrderId}] → ${phone}:`, e.message);
    }
  } else {
    console.warn(`[razorpay-webhook] no customer phone on ${inkOrderId} — WhatsApp skipped`);
  }
  // Customer email — the browser path sends this normally; in webhook-recovery it
  // was missing, so customers without an email-aware browser callback got nothing
  // textual to point them at.
  if (email) {
    try {
      await sendEmail({
        to: email,
        subject: `Your Ink & Chai order is confirmed! (${inkOrderId})`,
        html: emailBase(`
          <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">Order Confirmed 📚</h2>
          <p style="color:#a09080;line-height:1.8;margin-bottom:16px;">
            Hi ${firstName}, your books are on their way!<br/>
            Your payment of <strong style="color:#c9a84c;">${amtDisplay}</strong> was received successfully.
          </p>
          <p style="color:#a09080;font-size:13px;"><strong style="color:#f0e8d8;">Delivery address:</strong><br/>${address || '—'}</p>
          <p style="margin-top:16px;color:#7a6330;font-size:12px;">Order ID: <strong style="color:#c9a84c;">${inkOrderId}</strong></p>
          <div style="margin-top:20px;padding:14px 16px;background:#1c1916;border-left:3px solid #c9a84c;">
            <p style="color:#f0e8d8;font-size:13px;margin:0 0 10px;">📦 Track your order any time</p>
            <a href="https://inkandchai.in/track/?id=${encodeURIComponent(inkOrderId)}&q=${encodeURIComponent(email || phone || '')}" style="display:inline-block;background:#c9a84c;color:#0d0b08;padding:10px 22px;text-decoration:none;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:600;">Track Order →</a>
          </div>
        `),
      });
    } catch (e) {
      console.error(`[razorpay-webhook] customer email FAILED [${inkOrderId}] → ${email}:`, e.message);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, order: inkOrderId }) };
};
