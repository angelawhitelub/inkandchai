/**
 * Netlify Function: request-return
 * POST /.netlify/functions/request-return
 *
 * Lets a signed-in customer initiate a return request from My Orders. The
 * return window is seven days from delivery date when available, otherwise
 * seven days from order creation.
 */

const { createClient } = require('@supabase/supabase-js');

const { sendEmail } = require('./utils/email');
const { sendText } = require('./utils/whatsapp');
const {
  WALLET_BONUS_RUPEES,
  resolvePaymentType,
  refundBasePaise,
  mintWalletCredit,
} = require('./utils/return-refund');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

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
        <p style="margin:0;"><strong>Refund method:</strong> Ink &amp; Chai Wallet (store credit)</p>
        <p style="margin:6px 0 0;"><strong>Store-credit code issued:</strong> <code>${esc(info.walletCode)}</code> worth <strong>₹${(info.walletRupees||0).toLocaleString('en-IN')}</strong> (₹${rupees} refund + ₹${info.bonus} bonus).</p>
        <p style="margin:6px 0 0;color:#5a4a38;font-size:13px;">No payout needed — credit is already active for the customer.</p>
      </div>`;
  } else if (info.paymentType === 'cod') {
    refundBlock = `
      <div style="margin:16px 0;padding:14px 16px;background:#fbf1e6;border-left:4px solid #c9852b;">
        <p style="margin:0;"><strong>Refund method:</strong> Original method — <strong>COD → manual UPI payout</strong></p>
        <p style="margin:6px 0 0;font-size:16px;"><strong>Pay the customer ₹${rupees}</strong> to UPI: <strong style="color:#8a3a1f;">${esc(info.upiId)}</strong></p>
        <p style="margin:6px 0 0;color:#5a4a38;font-size:13px;">⚠️ Only pay out AFTER the returned book is back with you. Then mark it refunded.</p>
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
      <p>Your <strong>Ink &amp; Chai Wallet credit</strong> is ready to use now 🎉</p>
      <div style="margin:16px 0;padding:16px;background:#f4ecd9;border:1px dashed #c9a84c;text-align:center;">
        <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#8a6a1f;">Store credit</div>
        <div style="font-family:monospace;font-size:22px;color:#8a3a1f;margin:8px 0;">${esc(info.walletCode)}</div>
        <div style="font-size:20px;color:#4a9d4a;font-weight:600;">₹${(info.walletRupees||0).toLocaleString('en-IN')}</div>
        <div style="font-size:12px;color:#8a7a62;">(₹${rupees} refund + ₹${info.bonus} bonus) · valid 6 months</div>
      </div>
      <p style="font-size:13px;">Enter this code in the coupon box at checkout on your next order. Please keep the book and packaging ready — our courier will collect it.</p>`;
  } else if (info.paymentType === 'cod') {
    block = `
      <p>We've noted your refund of <strong>₹${rupees}</strong> to UPI <strong>${esc(info.upiId)}</strong>.</p>
      <p>We'll transfer it <strong>once the returned book reaches us</strong>. Please keep the book and packaging ready — our courier will collect it.</p>`;
  } else {
    block = `
      <p>Your refund of <strong>₹${rupees}</strong> will be sent back to your original payment method <strong>automatically once the returned book is delivered back to us</strong> — usually within a few days of pickup.</p>
      <p>Please keep the book and packaging ready — our courier will collect it.</p>`;
  }
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#2a2018;background:#faf7f2;">
      <h2 style="font-family:Georgia,serif;font-weight:400;color:#8a6a1f;margin:0 0 12px;">Ink &amp; Chai</h2>
      <p>Hi ${esc((order.customer_name || 'there').split(' ')[0])},</p>
      <p>We received your return request for order <strong>${esc(order.razorpay_order_id || order.id)}</strong>.</p>
      ${block}
      <p style="font-size:12px;color:#8a7a62;margin-top:24px;">Ink &amp; Chai · inkandchai.in</p>
    </div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
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
    const refundMethod = clean(body.refund_method, 20).toLowerCase(); // 'original' | 'wallet'
    const upiIdRaw = clean(body.upi_id, 80);
    if (!orderId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing order id.' }) };
    if (!['original', 'wallet'].includes(refundMethod)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Please choose a refund method: "original" or "wallet".' }) };
    }

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
    const refundPaise = refundBasePaise(order);             // what the customer paid
    const refundRupees = Math.round(refundPaise / 100);

    // COD + "original method" has no transaction to reverse — we pay out to UPI.
    let upiId = '';
    if (refundMethod === 'original' && paymentType === 'cod') {
      upiId = upiIdRaw;
      if (!/^[a-z0-9.\-_]{2,256}@[a-z]{2,64}$/i.test(upiId)) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Enter a valid UPI ID (e.g. name@bank) to receive your COD refund.', need_upi: true }) };
      }
    }

    const refundStatus = refundMethod === 'wallet'   ? 'wallet_issued'
                       : paymentType === 'cod'       ? 'manual_payout_pending'   // admin pays UPI after return received
                       :                               'awaiting_return_delivery'; // prepaid → auto-refund on return delivered

    // Save the return request first (so a mint failure never leaves an orphan code).
    const { data: inserted, error: insertErr } = await supabase.from('return_requests').insert({
      order_id:            order.id,
      order_display_id:    order.razorpay_order_id || order.id,
      customer_name:       order.customer_name    || '',
      customer_email:      order.customer_email   || '',
      customer_phone:      order.customer_phone   || '',
      customer_address:    order.customer_address || '',
      items:               order.cart_items       || [],
      amount_paise:        order.amount_paise      || 0,
      reason:              reason,
      // Auto-approve: 7-day window + delivered guard already enforced above.
      status:              'approved',
      refund_method:       refundMethod,
      payment_type:        paymentType,
      upi_id:              upiId || null,
      refund_amount_paise: refundPaise,
      refund_status:       refundStatus,
    }).select('id').single();
    if (insertErr) throw insertErr;

    // Wallet path → mint the store-credit code and attach it to the request.
    let walletCode = null, walletRupees = 0;
    if (refundMethod === 'wallet') {
      const minted = await mintWalletCredit(supabase, { order, valuePaise: refundPaise + WALLET_BONUS_RUPEES * 100 });
      walletCode = minted.code;
      walletRupees = Math.round(minted.value_paise / 100);
      await supabase.from('return_requests').update({ wallet_code: walletCode }).eq('id', inserted.id);
    }

    const info = { refundMethod, paymentType, upiId, refundRupees, walletCode, walletRupees, bonus: WALLET_BONUS_RUPEES };

    // ── Notify owner (email always; WhatsApp too for the COD manual payout) ────
    const ownerTo = process.env.STORE_OWNER_EMAIL || 'support@inkandchai.in';
    await sendEmail({
      to: ownerTo,
      subject: refundMethod === 'wallet'
        ? `Return + wallet credit: ${order.razorpay_order_id || order.id}`
        : (paymentType === 'cod'
            ? `⚠️ Return + COD refund ₹${refundRupees} → ${upiId} (${order.razorpay_order_id || order.id})`
            : `Return + prepaid refund ₹${refundRupees}: ${order.razorpay_order_id || order.id}`),
      html: ownerEmailHtml(order, reason, info),
    }).catch(e => console.error('request-return owner email:', e.message));

    if (refundMethod === 'original' && paymentType === 'cod' && process.env.STORE_OWNER_PHONE) {
      // Free-form text to the owner (they're inside the 24h window via the bot).
      // If out-of-window this silently no-ops; the email still lands.
      await sendText(
        process.env.STORE_OWNER_PHONE,
        `🔁 COD return — pay the customer\nOrder: ${order.razorpay_order_id || order.id}\nCustomer: ${order.customer_name || '—'} · ${order.customer_phone || '—'}\n💸 Refund ₹${refundRupees} to UPI: ${upiId}\n\n⚠️ Pay only AFTER the returned book reaches you.`
      ).catch(() => {});
    }

    // Notify the customer (email; WhatsApp for the wallet code so it's handy).
    await sendEmail({
      to: order.customer_email,
      subject: `Return approved (${order.razorpay_order_id || order.id})`,
      html: customerEmailHtml(order, info),
    }).catch(e => console.error('request-return customer email:', e.message));

    // ── Auto-push the reverse pickup to NimbusPost (backgrounded) ──────────────
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
        wallet_code: walletCode,
        wallet_rupees: walletRupees || null,
        auto_pickup: autoPickup,
        message: refundMethod === 'wallet'
          ? `Wallet credit of ₹${walletRupees} is ready — use code ${walletCode} at checkout. Keep the package ready for pickup.`
          : (paymentType === 'cod'
              ? `Return approved. We'll refund ₹${refundRupees} to ${upiId} once the book reaches us. Keep the package ready for pickup.`
              : `Return approved. ₹${refundRupees} will be refunded to your original payment method once the book is delivered back to us. Keep the package ready for pickup.`),
      }),
    };
  } catch (err) {
    console.error('request-return error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message || 'Could not submit return request.' }) };
  }
};
