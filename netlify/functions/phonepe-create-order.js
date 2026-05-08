/**
 * Netlify Function: phonepe-create-order
 * POST /.netlify/functions/phonepe-create-order
 *
 * Initiates a PhonePe Standard Checkout v1 payment. The frontend posts
 * { cart, customer, amount } here; we:
 *   1. Generate a merchantTransactionId (IC-YYYYMMDD-XXXXX, same scheme as
 *      our COD orders so the webhook + admin panel + tracking page all
 *      treat them identically).
 *   2. Insert a 'pending_phonepe' order row in Supabase so we have the
 *      cart/customer/address persisted before the customer leaves the site.
 *   3. Compute X-VERIFY = SHA256(base64Payload + "/pg/v1/pay" + saltKey)
 *      + "###" + saltIndex.
 *   4. POST to PhonePe's /pg/v1/pay; receive back a redirectUrl.
 *   5. Return the redirectUrl + orderId to the browser, which then
 *      window.location's the customer over to PhonePe.
 *
 * After payment, PhonePe redirects the customer back to the redirectUrl
 * we set (the verify-status function below) AND posts to the webhook.
 *
 * Required env vars:
 *   PHONEPE_MERCHANT_ID     (from PhonePe Business → Developer Settings)
 *   PHONEPE_SALT_KEY        (same place; never expose client-side)
 *   PHONEPE_SALT_INDEX      (usually "1")
 *   PHONEPE_HOST            (default api.phonepe.com — set api-preprod.phonepe.com for sandbox)
 *   SITE_URL                (e.g. https://inkandchai.in — used for redirectUrl)
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const FREE_SHIPPING_THRESHOLD = 499;
const SHIPPING_FEE = 40;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const merchantId = process.env.PHONEPE_MERCHANT_ID;
  const saltKey    = process.env.PHONEPE_SALT_KEY;
  const saltIndex  = process.env.PHONEPE_SALT_INDEX || '1';
  const host       = process.env.PHONEPE_HOST || 'https://api.phonepe.com/apis/hermes';
  const siteUrl    = process.env.SITE_URL || 'https://inkandchai.in';

  if (!merchantId || !saltKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'PhonePe credentials not configured. Set PHONEPE_MERCHANT_ID + PHONEPE_SALT_KEY in Netlify env vars.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { cart, customer } = body;
  if (!cart?.length || !customer?.phone) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing cart or phone' }) };
  }

  // Re-derive total server-side (don't trust client)
  const subtotal = cart.reduce((s, i) => s + (i.price * i.qty), 0);
  const shipping = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE;
  const total    = subtotal + shipping;
  const amountPaise = Math.round(total * 100);
  if (amountPaise < 100) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Amount too low' }) };
  }

  // Order id with same scheme as COD so webhook + admin treat them identically
  const now = new Date();
  const datePart = now.toISOString().slice(0,10).replace(/-/g,'');
  const randPart = Math.random().toString(36).slice(2,7).toUpperCase();
  const orderId  = `IC-${datePart}-${randPart}`;

  // ── 1. Save pending order to Supabase ────────────────────────────────────
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { error: dbErr } = await supabase.from('orders').insert({
      razorpay_order_id:   orderId,         // re-using existing column for our merchant order id
      razorpay_payment_id: null,            // filled when webhook confirms
      amount_paise:        amountPaise,
      status:              'pending_phonepe',
      customer_name:       customer.name    || '',
      customer_email:      customer.email   || '',
      customer_phone:      customer.phone,
      customer_address:    customer.address || '',
      cart_items:          cart,
    });
    if (dbErr) console.error('Supabase pre-order error (non-fatal):', dbErr.message);
  } catch (err) {
    console.error('Supabase exception (non-fatal):', err.message);
  }

  // ── 2. Build PhonePe payload + X-VERIFY signature ────────────────────────
  const redirectUrl = `${siteUrl}/.netlify/functions/phonepe-verify-status?id=${encodeURIComponent(orderId)}`;
  const payload = {
    merchantId,
    merchantTransactionId: orderId,
    merchantUserId: 'IAC-' + (customer.email || customer.phone || 'guest').replace(/[^a-zA-Z0-9]/g, '').slice(0, 30),
    amount: amountPaise,
    redirectUrl,
    redirectMode: 'REDIRECT',
    callbackUrl: `${siteUrl}/.netlify/functions/phonepe-webhook`,
    mobileNumber: (customer.phone || '').replace(/\D/g, '').slice(-10),
    paymentInstrument: { type: 'PAY_PAGE' },
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const stringToHash = payloadB64 + '/pg/v1/pay' + saltKey;
  const xVerify = crypto.createHash('sha256').update(stringToHash).digest('hex') + '###' + saltIndex;

  // ── 3. POST to PhonePe ───────────────────────────────────────────────────
  try {
    const res = await fetch(`${host}/pg/v1/pay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VERIFY': xVerify,
      },
      body: JSON.stringify({ request: payloadB64 }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.success) {
      console.error('PhonePe pay error:', res.status, JSON.stringify(data));
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ error: 'PhonePe error: ' + (data.message || data.code || ('HTTP ' + res.status)) }),
      };
    }

    const redirectTo = data.data?.instrumentResponse?.redirectInfo?.url;
    if (!redirectTo) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'PhonePe did not return a redirect URL' }) };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, order_id: orderId, redirect_url: redirectTo }),
    };

  } catch (err) {
    console.error('PhonePe network error:', err);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach PhonePe: ' + err.message }) };
  }
};
