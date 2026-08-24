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
 *   Events: payment.captured, payment_link.paid, payment.failed
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { sendWhatsApp } = require('./utils/whatsapp');
const { sendEmail }    = require('./utils/email');
const { generateCardForOrder } = require('./utils/scratch-cards');
const { pushToNimbusOnce } = require('./utils/nimbus-push-once');
const { makeOrderId } = require('./utils/pricing');
const { mirrorOrder, stashLostOrder } = require('./utils/order-fallback');

const CORS = { 'Content-Type': 'application/json' };

// Last-resort rebuild of line items from a `books` note when no cart snapshot or
// abandoned-checkout row exists. The note is a comma-separated "Title ×qty" list
// (create-order.js) or, for legacy/bot links, a single title. Split it into one
// line PER TITLE with its parsed quantity, and spread the paid amount across all
// units so the totals still add up — never one placeholder line at the full price.
function splitBooksNote(note, amountPaise) {
  const raw = String(note || '').trim();
  if (!raw) return [];
  // Structural separators only (comma/semicolon/newline/pipe/bullet), never
  // " and "/"&"/"+" which live inside real titles. Strip a leading list marker
  // ("1. ", "- ") the LLM sometimes prepends. Mirrors splitBookTitles in
  // utils/push-bot-order.js so both order-creation paths split identically.
  const parts = raw
    .split(/[,;\n|•·]+/)
    .map(s => s.replace(/^\s*(?:\d{1,2}[.)]|[-*])\s+/, '').trim())
    .filter(Boolean);
  const lines = parts.map(p => {
    const m = p.match(/^(.*?)[\s]*[x×✕✖]\s*(\d{1,3})$/i);   // "Title ×3"
    if (m && Number(m[2]) > 0) return { title: m[1].trim(), qty: Number(m[2]) };
    return { title: p, qty: 1 };
  }).filter(l => l.title);
  if (!lines.length) return [];
  const totalUnits = lines.reduce((s, l) => s + l.qty, 0) || 1;
  const perUnit = Math.round((Number(amountPaise) || 0) / 100 / totalUnits);
  return lines.map(l => ({ title: l.title, qty: l.qty, price: perUnit }));
}

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

  const event_type  = payload.event;
  const payment     = payload.payload?.payment?.entity;
  const orderEntity = payload.payload?.order?.entity || null;
  const paymentLink = payload.payload?.payment_link?.entity || null;

  console.log(`[razorpay-webhook] event=${event_type} payment_id=${payment?.id} order_id=${payment?.order_id} status=${payment?.status}`);

  // Only process captured payments. Payment Links usually arrive as
  // payment_link.paid with payment + order + payment_link entities.
  if (!['payment.captured', 'payment_link.paid'].includes(event_type) || !payment) {
    return { statusCode: 200, body: 'OK' };
  }

  const razorpay_order_id  = payment.order_id || paymentLink?.order_id || orderEntity?.id; // order_XXXXXX
  const razorpay_payment_id = payment.id;        // pay_XXXXXX
  const amount_paise       = payment.amount;
  const notes = {
    ...(orderEntity?.notes || {}),
    ...(paymentLink?.notes || {}),
    ...(payment.notes || {}),
  };
  const linkCustomer      = paymentLink?.customer || {};
  const customerEmail     = payment.email || linkCustomer.email || notes.customer_email || '';
  const customerPhone     = payment.contact || linkCustomer.contact || notes.customer_phone || '';
  // notes.customer_name is set by create-order.js; also try notes.name as fallback
  const customerName      = notes.customer_name || notes.name || linkCustomer.name || '';

  if (!razorpay_order_id || !razorpay_payment_id) {
    return { statusCode: 200, body: 'OK — no order/payment id' };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Check if order already exists (handler() may have already saved it) ──
  const { data: existing } = await supabase
    .from('orders')
    .select('id, razorpay_order_id, status, customer_name, customer_phone, customer_address, cart_items, amount_paise')
    .eq('razorpay_payment_id', razorpay_payment_id)
    .maybeSingle();

  if (existing) {
    const botOrderIdForRepair = notes.bot_order_id || paymentLink?.reference_id || orderEntity?.receipt || '';
    if (botOrderIdForRepair) {
      try {
        const { data: botReq } = await supabase
          .from('bot_order_requests')
          .select('order_id, customer_name, address, books, customer_phone')
          .eq('order_id', botOrderIdForRepair)
          .maybeSingle();
        if (botReq) {
          const patch = {};
          if (!existing.customer_name && botReq.customer_name) patch.customer_name = botReq.customer_name;
          if (!existing.customer_address && botReq.address) patch.customer_address = botReq.address;
          if (!existing.customer_phone && botReq.customer_phone) patch.customer_phone = botReq.customer_phone;
          if ((!Array.isArray(existing.cart_items) || !existing.cart_items.length) && botReq.books) {
            patch.cart_items = splitBooksNote(botReq.books, existing.amount_paise || amount_paise || 0);
          }
          if (!/^IC-W-/i.test(existing.razorpay_order_id || '') && /^IC-W-\d{8}-[A-Z0-9]{5}$/i.test(botReq.order_id || '')) {
            patch.razorpay_order_id = botReq.order_id.toUpperCase();
          }
          if (Object.keys(patch).length) await supabase.from('orders').update(patch).eq('id', existing.id);
          await supabase.from('bot_order_requests').update({
            status: 'ordered',
            order_pushed_id: patch.razorpay_order_id || existing.razorpay_order_id,
            payment_status: 'paid',
            paid_at: new Date().toISOString(),
          }).eq('order_id', botReq.order_id);
        }
      } catch (e) {
        console.warn('[razorpay-webhook] existing bot-order repair skipped:', e.message);
      }
    }
    console.log(`[razorpay-webhook] Already saved as ${existing.razorpay_order_id} — skip`);
    return { statusCode: 200, body: 'OK — already exists' };
  }

  // ── Authoritative cart snapshot (create-order.js writes this) ─────────────
  // Keyed by the Razorpay order id, this holds the FULL server-resolved cart —
  // every title, qty and price. It's the source of truth when the browser's
  // verify-payment callback never fired and this webhook has to create the row.
  // Without it we used to collapse the whole order into one placeholder line.
  // Best-effort: silently null until sql/order_carts.sql is run.
  let orderCart = null;
  try {
    const { data } = await supabase
      .from('order_carts')
      .select('cart_items, customer, payment_mode, full_total_paise')
      .eq('razorpay_order_id', razorpay_order_id)
      .maybeSingle();
    orderCart = data || null;
  } catch (e) { console.warn('[razorpay-webhook] order_carts lookup skipped:', e.message); }

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
  const evSource = notes.source || abandoned?.source || '';
  if (evSource === 'paperbound') {
    console.log('[razorpay-webhook] paperbound order — skip (handled by paperbound webhook)');
    return { statusCode: 200, body: 'OK — other store' };
  }

  // Prefer the authoritative snapshot, then abandoned-checkout, then nothing.
  const cart     = (Array.isArray(orderCart?.cart_items) && orderCart.cart_items.length)
                     ? orderCart.cart_items
                     : (abandoned?.cart_items || []);
  const customer = orderCart?.customer || abandoned?.customer || {};
  let   name     = customer.name    || customerName   || '';
  let   email    = customer.email   || customerEmail  || '';
  let   phone    = customer.phone   || customerPhone  || '';
  let   address  = customer.address || notes.shipping_address || '';
  let   notesBooks = notes.books || '';

  // WhatsApp-bot payment links: the customer's name/address live in
  // bot_order_requests, not on the payment. If this payment came from a bot
  // link (notes.bot_order_id) and we're still missing name/address, pull them
  // from that row so the order isn't saved blank with a void@razorpay.com email.
  const botOrderId = notes.bot_order_id || paymentLink?.reference_id || orderEntity?.receipt || '';
  let botReq = null;
  if (botOrderId) {
    try {
      const { data } = await supabase
        .from('bot_order_requests')
        .select('customer_name, address, books, customer_phone, amount_paise, order_pushed_id')
        .eq('order_id', botOrderId)
        .maybeSingle();
      botReq = data || null;
      if (botReq) {
        name       = name    || botReq.customer_name || '';
        address    = address || botReq.address       || '';
        phone      = phone   || botReq.customer_phone || '';
        notesBooks = notesBooks || botReq.books       || '';
      }
    } catch (e) { console.warn('[razorpay-webhook] bot_order_requests lookup:', e.message); }
  }
  // Razorpay uses void@razorpay.com when no real email was collected — don't
  // store that placeholder; leave the field blank instead.
  if (/^void@razorpay\.com$/i.test(email)) email = '';

  // If we still have no real cart (no snapshot, no abandoned checkout), rebuild
  // line items from the `books` note. create-order.js now writes that note as a
  // comma-separated "Title ×qty" list, so split it into SEPARATE lines with
  // their quantities instead of one placeholder priced at the whole amount —
  // that single-line collapse is exactly what shipped one book on a 5-book order.
  const cartItems = cart.length > 0 ? cart : splitBooksNote(notesBooks, amount_paise);

  // ── Partial COD ──────────────────────────────────────────────────────────
  // A partial-COD deposit is an ordinary captured payment as far as Razorpay is
  // concerned: `payment.captured` carries ₹63 on a ₹625 order and says nothing
  // about the balance. Saving that as a plain 'paid' order made this webhook
  // push the shipment to NimbusPost as PREPAID with ₹63 declared — so the
  // courier collected nothing and the customer never paid the remaining ₹562.
  // create-order.js records the real mode in both the order_carts snapshot and
  // the Razorpay notes; use them.
  const isPartial = String(orderCart?.payment_mode || notes.server_payment_mode || '') === 'partial_cod';
  const fullTotalRs = Math.round(
    (Number(orderCart?.full_total_paise) || Number(notes.server_full_total_paise) || 0) / 100
  ) || cartItems.reduce((s, i) => s + (Number(i.price) || 0) * Math.max(1, Number(i.qty || i.quantity) || 1), 0);
  const depositRs = Math.round(amount_paise / 100);
  const balanceRs = Math.max(0, fullTotalRs - depositRs);
  if (isPartial && cartItems[0]) {
    // Same shape verify-payment writes, so every downstream reader (the pusher,
    // the AWB sync, the admin panel) sees one consistent partial-COD marker
    // whichever path created the row.
    cartItems[0]._payment = {
      mode: 'partial_cod',
      full_total: fullTotalRs,
      deposit: depositRs,
      balance: balanceRs,
      rate: 0.10,
    };
  }

  // IC- (or IC-CW- for Crossword-migrated genuine-tag carts) order ID.
  const inkOrderId = /^IC-W-\d{8}-[A-Z0-9]{5}$/i.test(botOrderId || '')
    ? botOrderId.toUpperCase()
    : await makeOrderId('IC', cartItems, supabase);

  // ── Save the order ────────────────────────────────────────────────────────
  const orderRow = {
    razorpay_order_id:   inkOrderId,
    razorpay_payment_id: razorpay_payment_id,
    amount_paise:        amount_paise,
    status:              isPartial ? 'partial_cod_pending' : 'paid',
    customer_name:       name,
    customer_email:      email,
    customer_phone:      phone,
    customer_address:    address,
    cart_items:          cartItems,
  };
  await mirrorOrder(event, orderRow, { source: 'razorpay-webhook' });
  const { error: saveErr } = await supabase.from('orders').insert(orderRow);

  if (saveErr) {
    // Unique-violation on razorpay_payment_id means the browser callback already
    // created this order. Stop here — do NOT continue to scratch card / WhatsApp,
    // or the customer would be notified twice for one order.
    if (saveErr.code === '23505') {
      console.log('[razorpay-webhook] order already exists (browser created it) — skip');
      return { statusCode: 200, body: 'OK — already exists' };
    }
    console.error('[razorpay-webhook] DB save error:', saveErr.message);
    // The 500 is deliberate — it makes Razorpay retry, and on 24 Aug that retry
    // is what eventually saved a paid order after an eight-hour outage. The
    // stash is the backstop for when Razorpay gives up before the DB returns.
    await stashLostOrder(event, orderRow, { source: 'razorpay-webhook', reason: saveErr.message });
    return { statusCode: 500, body: JSON.stringify({ error: saveErr.message }) };
  }

  if (botReq && /^IC-W-/i.test(inkOrderId)) {
    await supabase.from('bot_order_requests').update({
      status: 'ordered',
      order_pushed_id: inkOrderId,
      payment_status: 'paid',
      paid_at: new Date().toISOString(),
    }).eq('order_id', inkOrderId);
  }

  console.log(`[razorpay-webhook] ✅ Saved missed order: ${inkOrderId} (${razorpay_payment_id})`);

  // ── Auto-push recovered order to NimbusPost panel (no AWB) ───────────────
  // Claim-guarded: verify-payment pushes the same order from the browser
  // callback. The stamp is the lock, so only one of the two reaches the panel
  // and a failed push releases it for the other to retry.
  pushToNimbusOnce(supabase, {
    razorpay_order_id: inkOrderId,
    status: isPartial ? 'partial_cod_pending' : 'paid',
    razorpay_payment_id,
    customer_name: name || '',
    customer_phone: phone || '',
    customer_address: address || '',
    amount_paise: amount_paise,
    cart_items: cartItems,
  }).catch(e => console.error('[NimbusPost] auto-push failed (non-fatal):', e.message));

  // ── Scratch card reward (non-fatal) ──────────────────────────────────────
  // Full prepaid only — matches verify-payment. A partial-COD customer has paid
  // a 10% deposit and still owes the balance.
  if (!isPartial) {
    generateCardForOrder(supabase, {
      razorpay_order_id: inkOrderId,
      status: 'paid',
      customer_phone: phone, customer_email: email, customer_name: name,
    }).catch(e => console.error('[ScratchCard] generate failed (non-fatal):', e.message));
  }

  // ── Notify store owner ───────────────────────────────────────────────────
  const ownerEmail = process.env.STORE_OWNER_EMAIL;
  if (ownerEmail) {
    const amtDisplay = `₹${(amount_paise / 100).toLocaleString('en-IN')}`;
    await sendEmail({
      to: ownerEmail,
      subject: `⚡ Recovered Payment — ${inkOrderId} · ${amtDisplay}${isPartial ? ` (partial COD · collect ₹${balanceRs.toLocaleString('en-IN')})` : ''}`,
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
        ${isPartial
          ? `<p style="color:#c9a84c;font-size:13px;background:#1c1916;padding:10px 14px;margin-top:16px;">💰 Partial COD — customer paid ₹${depositRs.toLocaleString('en-IN')} now. Collect <strong>₹${balanceRs.toLocaleString('en-IN')}</strong> on delivery. Full order value ₹${fullTotalRs.toLocaleString('en-IN')}.</p>`
          : `<p style="color:#6dbf6d;font-size:13px;margin-top:16px;">✅ Order is confirmed and ready to ship.</p>`}
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
            ${isPartial
              ? `We received your 10% booking payment of <strong style="color:#c9a84c;">${amtDisplay}</strong>. Please keep the remaining <strong style="color:#c9a84c;">₹${balanceRs.toLocaleString('en-IN')}</strong> ready for the delivery agent.`
              : `Your payment of <strong style="color:#c9a84c;">${amtDisplay}</strong> was received successfully.`}
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
