/**
 * Netlify Function: request-return
 * POST /.netlify/functions/request-return
 *
 * A signed-in customer returns some or all of the books on a delivered order,
 * within seven days of delivery, from My Orders. Back since 2026-10-23 next to
 * replacements (retired 2026-10-02 to 10-23); RETURNS_ENABLED=off turns it off.
 *
 * The request is recorded and the reverse pickup booked straight away
 * (auto-return-pickup-background: XpressBees, then NimbusPost, else India
 * Post). The customer sees it approved, with the pickup AWB, once a courier
 * accepts. Nothing is paid out here: the refund, or the store credit, is
 * issued when the parcel is delivered back to us (utils/return-auto-refund).
 *
 * Since 30 Oct 2026 the payment mode decides the refund (returnRefundMethod):
 * prepaid → the original payment method, COD and partial COD → store credit.
 */

const { createClient } = require('@supabase/supabase-js');

const { sendEmail } = require('./utils/email');
const {
  WALLET_BONUS_RUPEES,
  resolvePaymentType,
  returnRefundMethod,
  pickReturnItems,
} = require('./utils/return-refund');
const { isReplacementOrder } = require('./utils/replacement-order');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const returnsEnabled = () => String(process.env.RETURNS_ENABLED || '').toLowerCase() !== 'off';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clean(value, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function withinReturnWindow(order) {
  // Returns are ONLY allowed after the order has been delivered.
  // Using delivered_at exclusively — shipped_at / created_at are not valid
  // anchors because the customer hasn't received the book yet.
  if (!order.delivered_at) return false;
  const deliveredTime = new Date(order.delivered_at).getTime();
  if (!Number.isFinite(deliveredTime)) return false;
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  return Date.now() <= deliveredTime + sevenDays;
}


function ownerEmailHtml(order, reason, info = {}) {
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const rows = items.map(i => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eadfca;">${esc(i.title)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eadfca;text-align:center;">${esc(i.qty)}</td>
    </tr>`).join('');

  const rupees = (info.refundRupees || 0).toLocaleString('en-IN');
  let refundBlock = '';
  if (info.refundMethod === 'wallet') {
    refundBlock = `
      <div style="margin:16px 0;padding:14px 16px;background:#eef7ec;border-left:4px solid #4a9d4a;">
        <p style="margin:0;"><strong>Refund method:</strong> Ink &amp; Chai Wallet (store credit — ${info.paymentType === 'partial_cod' ? 'partial COD' : 'COD'} orders are refunded in store credit only)</p>
        <p style="margin:6px 0 0;">A store-credit code worth <strong>₹${(info.walletRupees||0).toLocaleString('en-IN')}</strong> (₹${rupees} refund + ₹${info.bonus} bonus) is issued automatically when the parcel is delivered back to us.</p>
      </div>`;
  } else {
    refundBlock = `
      <div style="margin:16px 0;padding:14px 16px;background:#eef2fb;border-left:4px solid #3f5fba;">
        <p style="margin:0;"><strong>Refund method:</strong> Original method — <strong>prepaid</strong></p>
        <p style="margin:6px 0 0;">₹${rupees} will be <strong>auto-refunded via the payment gateway</strong> once the returned book is scanned delivered back to us. No action needed unless it fails.</p>
      </div>`;
  }

  return `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#2a2018;background:#faf7f2;padding:24px;">
      <h2 style="font-family:Georgia,serif;color:#8a6a1f;font-weight:400;">New return request</h2>
      <p style="font-size:13px;color:#5a4a38;">The reverse pickup is being booked automatically (XpressBees, then NimbusPost, else the customer is asked to Speed Post it). You are told separately if no courier takes it.</p>
      <p><strong>Order:</strong> ${esc(order.razorpay_order_id || order.id)}</p>
      <p><strong>Customer:</strong> ${esc(order.customer_name)}<br>
      <strong>Email:</strong> ${esc(order.customer_email)}<br>
      <strong>Phone:</strong> ${esc(order.customer_phone)}</p>
      ${refundBlock}
      <p><strong>Reason:</strong><br>${esc(reason || 'Customer did not provide a reason.')}</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#fff;">
        <thead><tr><th style="padding:8px 10px;text-align:left;color:#8a6a1f;">Book</th><th style="padding:8px 10px;color:#8a6a1f;">Qty</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="font-size:13px;color:#5a4a38;"><strong>Address:</strong><br>${esc(order.customer_address)}</p>
    </div>`;
}

function customerEmailHtml(order, info = {}) {
  const rupees = (info.refundRupees || 0).toLocaleString('en-IN');
  let block;
  if (info.refundMethod === 'wallet') {
    block = `
      <p>As this was a Cash on Delivery order, it is refunded as <strong>Ink &amp; Chai store credit</strong>: <strong>₹${(info.walletRupees||0).toLocaleString('en-IN')}</strong> (₹${rupees} refund + ₹${info.bonus} bonus), valid 6 months. We email you the code as soon as the books reach us.</p>`;
  } else {
    block = `
      <p>Your refund of <strong>₹${rupees}</strong> goes back to your original payment method <strong>automatically once the books are delivered back to us</strong>.</p>`;
  }
  const books = (info.items || []).map(i => `${esc(i.title)}${Number(i.qty) > 1 ? ' × ' + esc(i.qty) : ''}`).join('<br>');
  block = (books ? `<p><strong>Returning:</strong><br>${books}</p>` : '')
    + `<p>We're booking a courier to collect them now. As soon as the courier accepts, we'll send you the pickup tracking number by email and WhatsApp, and it shows on My Orders. Please keep the books packed and ready.</p>`
    + block
    + `<p style="font-size:13px;color:#5a4a38;">A pickup usually takes 2–3 days to reach our warehouse; the refund is issued when it arrives, not at pickup.</p>`;
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#2a2018;background:#faf7f2;">
      <h2 style="font-family:Georgia,serif;font-weight:400;color:#8a6a1f;margin:0 0 12px;">Ink &amp; Chai</h2>
      <p>Hi ${esc((order.customer_name || 'there').split(' ')[0])},</p>
      <p>We've received your return request for order <strong>${esc(order.razorpay_order_id || order.id)}</strong>.</p>
      ${block}
      <p style="font-size:12px;color:#8a7a62;margin-top:24px;">Ink &amp; Chai · inkandchai.in</p>
    </div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // The switch the owner can pull without a deploy (Worker var RETURNS_ENABLED=off).
  if (!returnsEnabled()) {
    return { statusCode: 410, headers: CORS, body: JSON.stringify({
      error: 'Returns are not available right now. If your book arrived defective, misprinted, wrong or missing, request a free replacement from My Orders or the Track Order page.',
      replacement_only: true,
    }) };
  }

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase is not configured.' }) };
    }

    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Please sign in first.' }) };

    const body = JSON.parse(event.body || '{}');
    const orderId = clean(body.order_id || body.id, 120);
    const reason = clean(body.reason, 1000);
    if (!orderId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing order id.' }) };

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: userResult, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userResult?.user?.email) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Please sign in again.' }) };
    }
    const email = userResult.user.email.toLowerCase();

    const { data: order, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .maybeSingle();
    if (error) throw error;
    if (!order || String(order.customer_email || '').toLowerCase() !== email) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Order not found for this account.' }) };
    }
    const orderStatus = String(order.status || '').toLowerCase();
    if (['cancelled', 'refunded'].includes(orderStatus)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'This order is not eligible for return.' }) };
    }
    // Must be delivered before a return can be raised
    if (orderStatus !== 'delivered') {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Returns can only be initiated after the order has been delivered. Please wait until delivery is confirmed.' }) };
    }
    if (!withinReturnWindow(order)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'The 7-day return window has expired for this order.' }) };
    }
    // A free replacement was never paid for, so there is nothing to refund on it;
    // and an order that already had a free replacement is settled that way.
    if (isReplacementOrder(order)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'A free replacement order cannot be returned for a refund.' }) };
    }
    if (order.razorpay_order_id) {
      const { data: repl } = await supabase.from('orders').select('razorpay_order_id')
        .eq('cart_items->0->_replacement->>original_order_id', order.razorpay_order_id).limit(1);
      if (repl && repl.length) {
        return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: `A free replacement (${repl[0].razorpay_order_id}) was already sent for this order, so it cannot also be returned. Please contact support.` }) };
      }
    }
    const pick = pickReturnItems(order, body.items);
    if (!pick.ok) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: pick.error }) };

    // Reject duplicate return requests for the same order
    const { data: existing } = await supabase
      .from('return_requests')
      .select('id, status')
      .eq('order_id', order.id)
      .maybeSingle();

    if (existing) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({
          error: 'A return request has already been submitted for this order. Our team will be in touch shortly. Please keep the package ready to hand over to the courier.',
          already_submitted: true,
        }),
      };
    }

    // ── Refund method resolution ──────────────────────────────────────────────
    const paymentType = resolvePaymentType(order);          // 'prepaid' | 'cod' | 'partial_cod'
    const refundPaise = pick.refundPaise;                   // what they paid for the books coming back
    const refundRupees = Math.round(refundPaise / 100);

    // Not the customer's choice any more: prepaid → original method, COD and
    // partial COD → store credit. body.refund_method from an older page is ignored.
    const refundMethod = returnRefundMethod(paymentType);

    // Both are settled on receipt (utils/return-auto-refund), never before the
    // books are back: handing credit out at request paid people who never sent them.
    const refundStatus = 'awaiting_return_delivery';

    // Save the return request first (so a mint failure never leaves an orphan code).
    const baseRow = {
      order_id:            order.id,
      order_display_id:    order.razorpay_order_id || order.id,
      customer_name:       order.customer_name    || '',
      customer_email:      order.customer_email   || '',
      customer_phone:      order.customer_phone   || '',
      customer_address:    order.customer_address || '',
      items:               pick.items,
      amount_paise:        refundPaise,
      reason:              reason,
      // 'approved' lets the pickup be booked at once (auto-return-pickup); the
      // customer is shown it approved only when a courier accepts it.
      status:              'approved',
      refund_method:       refundMethod,
      payment_type:        paymentType,
      refund_amount_paise: refundPaise,
      refund_status:       refundStatus,
    };
    const { data: inserted, error: insertErr } = await supabase
      .from('return_requests').insert(baseRow).select('id').single();
    if (insertErr) throw insertErr;

    const walletRupees = refundMethod === 'wallet' ? refundRupees + WALLET_BONUS_RUPEES : 0;

    const info = { refundMethod, paymentType, refundRupees, walletRupees, bonus: WALLET_BONUS_RUPEES };

    // ── Notify owner (email) ────────────────────────────────────────────────────
    const ownerTo = process.env.STORE_OWNER_EMAIL || 'support@inkandchai.in';
    await sendEmail({
      to: ownerTo,
      subject: refundMethod === 'wallet'
        ? `Return + wallet credit: ${order.razorpay_order_id || order.id}`
        : `Return + prepaid refund ₹${refundRupees}: ${order.razorpay_order_id || order.id}`,
      html: ownerEmailHtml({ ...order, cart_items: pick.items }, reason, info),
    }).catch(e => console.error('request-return owner email:', e.message));

    // Notify the customer (email; WhatsApp for the wallet code so it's handy).
    await sendEmail({
      to: order.customer_email,
      subject: `Return request received (${order.razorpay_order_id || order.id})`,
      html: customerEmailHtml(order, { ...info, items: pick.items }),
    }).catch(e => console.error('request-return customer email:', e.message));

    // ── Auto-book the reverse pickup (backgrounded) ────────────────────────────
    // XpressBees first, then NimbusPost, else the customer is asked to Speed Post
    // it and we reimburse the postage: see auto-return-pickup-background.js.
    // The return is auto-approved above; now book the NimbusPost reverse pickup
    // so an AWB is assigned and the customer is told the courier will collect the
    // books — no manual admin step. This is dispatched to a BACKGROUND function
    // (Netlify returns 202 instantly, 15-min budget) rather than done inline: the
    // reverse pickup (NP login + serviceability + shipment + notifications) takes
    // ~10s, which added to this handler's own work would blow the 10s synchronous
    // timeout and silently drop the push (that's exactly what left earlier returns
    // "approved, no AWB"). The background worker reuses process-return and emails
    // the owner if it can't schedule (e.g. no reverse courier for the pincode), so
    // failures are visible, not silent. Best-effort: never blocks the customer.
    let autoPickup = { attempted: false, queued: false };
    try {
      const site = String(process.env.SITE_URL || process.env.URL || 'https://inkandchai.in').replace(/\/$/, '');
      const secret = process.env.ADMIN_SECRET || '';
      if (!secret) {
        autoPickup = { attempted: false, queued: false, error: 'ADMIN_SECRET not set' };
        console.warn('[request-return] auto-pickup skipped: ADMIN_SECRET not set');
      } else {
        const pr = await fetch(`${site}/.netlify/functions/auto-return-pickup-background`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': secret },
          body: JSON.stringify({ return_request_id: inserted.id }),
        });
        // Background functions ack with 202 (accepted) and finish out-of-band.
        autoPickup = { attempted: true, queued: pr.status === 202 || pr.ok, status: pr.status };
        console.log(`[request-return] auto-pickup queued for ${inserted.id} (HTTP ${pr.status})`);
      }
    } catch (e) {
      autoPickup = { attempted: true, queued: false, error: e.message };
      console.error('[request-return] auto-pickup dispatch error:', e.message);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        refund_method: refundMethod,
        payment_type: paymentType,
        refund_rupees: refundRupees,
        wallet_rupees: walletRupees || null,
        items: pick.items,
        auto_pickup: autoPickup,
        message: 'Return requested. We are booking the courier pickup now — you will see it approved here, with the pickup tracking number, as soon as the courier accepts it. '
          + (refundMethod === 'wallet'
            ? `Cash on Delivery orders are refunded in store credit: ₹${walletRupees} (₹${refundRupees} + ₹${WALLET_BONUS_RUPEES} bonus) is issued when the books reach us.`
            : `₹${refundRupees} is refunded to your original payment method when the books reach us.`),
      }),
    };
  } catch (err) {
    console.error('request-return error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message || 'Could not submit return request.' }) };
  }
};
