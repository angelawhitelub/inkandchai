/**
 * Netlify Function: phonepe-refund
 * POST /.netlify/functions/phonepe-refund
 *
 * Admin endpoint — issues a full refund via PhonePe's v2 API for orders
 * with status='refund_pending' that have a PhonePe payment ID (starts with
 * "OM" or "T" — not Razorpay "pay_").
 *
 * Body: { order_id: "IC-20260530-U67JU" }  (razorpay_order_id / display ID)
 *
 * PhonePe Refund API (v2):
 *   POST {host}/pg/v1/refund        -- legacy v1 path, still registered
 *   POST {host}/pg/payments/v2/refund -- current v2 path
 *   Body: { merchantRefundId, originalMerchantOrderId, amount: <paise> }
 *   Auth: O-Bearer <oauth_token>
 *
 * The old path `/pg/checkout/v2/order/{id}/refund` returns
 * "Api Mapping Not Found" — that endpoint was never registered, the docs
 * were wrong / pre-release. Use /pg/payments/v2/refund with the order id
 * in the body as `originalMerchantOrderId`.
 */

const { createClient } = require('@supabase/supabase-js');
const { sendEmail }    = require('./utils/email');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

let _tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken(host) {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }
  const body = new URLSearchParams({
    client_id:      process.env.PHONEPE_CLIENT_ID,
    client_secret:  process.env.PHONEPE_CLIENT_SECRET,
    client_version: process.env.PHONEPE_CLIENT_VERSION || '1',
    grant_type:     'client_credentials',
  });
  const res = await fetch(`${host}/identity-manager/v1/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error('PhonePe OAuth failed: ' + (data.message || data.error || ('HTTP ' + res.status)));
  }
  _tokenCache = {
    token: data.access_token,
    expiresAt: data.expires_at ? data.expires_at * 1000 : Date.now() + (data.expires_in || 3300) * 1000,
  };
  return _tokenCache.token;
}

function refundConfirmHtml(order, refundId, refundAmtPaise, isFull) {
  const refundAmt = `₹${(refundAmtPaise / 100).toLocaleString('en-IN')}`;
  const orderAmt  = order.amount_paise ? `₹${(order.amount_paise / 100).toLocaleString('en-IN')}` : '—';
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#2a2018;background:#faf7f2;">
      <h2 style="font-family:Georgia,serif;font-weight:400;color:#8a6a1f;margin:0 0 12px;">Ink &amp; Chai</h2>
      <p>Hi ${(order.customer_name || 'there').split(' ')[0]},</p>
      <p>${isFull ? 'A full refund' : `A partial refund of <strong>${refundAmt}</strong>`} for order <strong>${order.razorpay_order_id || order.id}</strong> has been processed via PhonePe.${isFull ? ` Refund amount: <strong>${refundAmt}</strong>.` : ` (Original order: ${orderAmt}.)`}</p>
      <p>Refund ID: <strong>${refundId}</strong><br/>
      The amount will appear in your original payment method within <strong>5–7 business days</strong>.</p>
      <p style="font-size:12px;color:#8a7a62;margin-top:24px;">Ink &amp; Chai · inkandchai.in</p>
    </div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const displayId = String(body.order_id || '').trim();
  if (!displayId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide order_id' }) };
  }

  const host = process.env.PHONEPE_HOST || 'https://api.phonepe.com/apis';

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Look up order
    const { data: order } = await supabase
      .from('orders')
      .select('*')
      .eq('razorpay_order_id', displayId)
      .maybeSingle();

    if (!order) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: `Order not found: ${displayId}` }) };
    }
    if (order.status === 'refunded') {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Order is already refunded.' }) };
    }
    // Allow refunds from any state where money is with us. (Previously only
    // refund_pending/cancelled — meant admin had to flip status manually first
    // before refunding, friction the user wanted gone.)
    const REFUNDABLE = ['paid', 'confirmed', 'shipped', 'out_for_delivery',
                        'delivered', 'refund_pending', 'partially_refunded',
                        'cancelled', 'rto', 'undelivered', 'lost'];
    if (!REFUNDABLE.includes(order.status)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Order status is '${order.status}' — not eligible for refund.` }) };
    }

    const paymentId = order.razorpay_payment_id || '';
    if (!paymentId || paymentId.startsWith('pay_')) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'This order has a Razorpay payment — use the Razorpay dashboard to refund, not this tool.' }) };
    }

    const orderAmount = order.amount_paise;
    if (!orderAmount || orderAmount <= 0) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Order has no amount to refund.' }) };
    }

    // Partial-refund support. Client may send `amount_paise` (or `amount_rupees`).
    // If omitted, default to a FULL refund of the captured amount.
    if (order.status === 'partially_refunded') {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'A partial refund was already issued on this order — issue a remaining-balance refund directly in the PhonePe dashboard.' }) };
    }
    let amountPaise = orderAmount;
    if (body.amount_paise != null) amountPaise = Math.round(Number(body.amount_paise));
    else if (body.amount_rupees != null) amountPaise = Math.round(Number(body.amount_rupees) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid refund amount.' }) };
    }
    if (amountPaise > orderAmount) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Refund ₹${amountPaise/100} exceeds order amount ₹${orderAmount/100}.` }) };
    }
    const isFullRefund = amountPaise >= orderAmount;

    // Generate a unique refund ID
    const merchantRefundId = `REFUND-${displayId}-${Date.now()}`;

    // Authenticate with PhonePe
    const token = await getAccessToken(host);

    // Issue refund via PhonePe v2 Payments API. The order id we sent at
    // creation time (the IC-… display id) goes in `originalMerchantOrderId`,
    // NOT in the URL path. The old path-style URL returns "Api Mapping Not
    // Found" because that endpoint was never registered for production
    // accounts. Try v2 first, then fall back to v1 path for older merchant
    // accounts that haven't been migrated yet.
    const refundBody = {
      merchantRefundId,
      originalMerchantOrderId: displayId,
      amount: amountPaise,                          // paise
    };
    const refundHeaders = {
      'Authorization': 'O-Bearer ' + token,
      'Content-Type': 'application/json',
    };

    async function callRefund(path) {
      const r = await fetch(`${host}${path}`, {
        method: 'POST', headers: refundHeaders, body: JSON.stringify(refundBody),
      });
      const text = await r.text();
      let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
      return { ok: r.ok, status: r.status, data };
    }

    let refundRes = await callRefund('/pg/payments/v2/refund');
    if (!refundRes.ok && /api mapping not found/i.test(JSON.stringify(refundRes.data))) {
      console.warn('PhonePe v2 refund returned ApiMappingNotFound, falling back to v1');
      refundRes = await callRefund('/pg/v1/refund');
    }
    const refundData = refundRes.data;
    console.log('PhonePe refund response:', refundRes.status, JSON.stringify(refundData).slice(0, 400));

    if (!refundRes.ok) {
      throw new Error(
        refundData.message || refundData.error || `PhonePe refund API returned HTTP ${refundRes.status}: ${JSON.stringify(refundData).slice(0, 200)}`
      );
    }

    const refundState = (refundData.state || refundData.status || '').toUpperCase();
    // PhonePe refund states: INITIATED, PENDING, COMPLETED, FAILED
    if (refundState === 'FAILED') {
      throw new Error('PhonePe rejected the refund: ' + (refundData.message || JSON.stringify(refundData).slice(0, 200)));
    }

    // Full -> refunded. Partial -> partially_refunded (one-shot — the upfront
    // guard above blocks a second partial refund). PhonePe's refund webhook
    // confirms final state asynchronously and re-asserts 'refunded' for full.
    const update = {
      razorpay_payment_id: paymentId,
      status: isFullRefund ? 'refunded' : 'partially_refunded',
    };
    await supabase.from('orders').update(update).eq('id', order.id);

    // Email customer
    if (order.customer_email) {
      await sendEmail({
        to: order.customer_email,
        subject: `Refund processed — ${displayId}`,
        html: refundConfirmHtml(order, merchantRefundId, amountPaise, isFullRefund),
      });
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        refund_id: merchantRefundId,
        state: refundState || 'INITIATED',
        amount: `₹${(amountPaise / 100).toLocaleString('en-IN')}`,
        is_full: isFullRefund,
        message: `${isFullRefund ? 'Full refund' : 'Partial refund'} of ₹${(amountPaise / 100).toLocaleString('en-IN')} initiated. Customer will receive it in 5-7 business days.`,
      }),
    };

  } catch (err) {
    console.error('phonepe-refund error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
