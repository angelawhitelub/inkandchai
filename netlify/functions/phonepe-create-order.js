/**
 * Netlify Function: phonepe-create-order
 * POST /.netlify/functions/phonepe-create-order
 *
 * Initiates a PhonePe PG v2 (PG_CHECKOUT) hosted-page payment.
 * Frontend posts { cart, customer }; we:
 *   1. Generate a merchantOrderId (IC-YYYYMMDD-XXXXX, same scheme as COD).
 *   2. Pre-insert a 'pending_phonepe' row in Supabase.
 *   3. Fetch an OAuth token from PhonePe identity-manager (cached).
 *   4. POST to /pg/checkout/v2/pay → get back { redirectUrl }.
 *   5. Return redirectUrl to the browser, which window.location's there.
 *
 * Required env vars (PhonePe Business → Developer Settings → API Keys):
 *   PHONEPE_CLIENT_ID
 *   PHONEPE_CLIENT_SECRET
 *   PHONEPE_CLIENT_VERSION   (default "1")
 *   PHONEPE_HOST             (default https://api.phonepe.com/apis  — use api-preprod-net for sandbox)
 *   SITE_URL                 (https://inkandchai.in)
 */

const { createClient } = require('@supabase/supabase-js');
const { resolveCartPrices } = require('./utils/pricing');
const { claimScratchCardForOrder } = require('./utils/scratch-cards');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const FREE_SHIPPING_THRESHOLD = 499;
const SHIPPING_FEE = 40;

function normalizeCouponCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Must stay in sync with COUPONS object in public/checkout/index.html
const COUPONS = {
  INKLOVE10:  { type: 'percent', value: 10, minSubtotal: 499  },
  '499HIT':   { type: 'percent', value: 10, minSubtotal: 499  },
  SAVE12:     { type: 'percent', value: 12, minSubtotal: 999  },
  SAVE15:     { type: 'percent', value: 15, minSubtotal: 1499 },
  CHAI10BACK: { type: 'percent', value: 10, minSubtotal: 299  },
};

function couponDiscount(subtotal, code) {
  const normalized = normalizeCouponCode(code);
  const coupon = COUPONS[normalized];
  if (!coupon || subtotal < coupon.minSubtotal) return { code: '', discount: 0 };
  const discount = coupon.type === 'percent'
    ? Math.floor(subtotal * coupon.value / 100)
    : Math.floor(coupon.value);
  return { code: normalized, discount: Math.max(0, discount) };
}

// Check static COUPONS first, then fall back to user-earned scratch cards
async function resolveCouponDiscount(supabase, subtotal, rawCode) {
  // Static check
  const staticResult = couponDiscount(subtotal, rawCode);
  if (staticResult.discount > 0) return { ...staticResult, source: 'static' };

  // Scratch card check — normalize: keep dashes for scratch codes
  const scratchCode = String(rawCode || '').toUpperCase().trim();
  if (!scratchCode.startsWith('SCRATCH-')) return { code: '', discount: 0 };

  const { data: card } = await supabase
    .from('scratch_cards').select('*').eq('code', scratchCode).maybeSingle();
  if (!card) return { code: '', discount: 0 };
  if (card.status !== 'scratched')                            return { code: '', discount: 0, error: 'not_scratched' };
  if (new Date(card.expires_at) < new Date())                 return { code: '', discount: 0, error: 'expired' };
  if (subtotal * 100 < (card.min_subtotal_paise || 0))        return { code: '', discount: 0, error: 'min_subtotal' };

  return {
    code: scratchCode,
    discount: Math.round(card.value_paise / 100),
    source: 'scratch',
    scratch_card_id: card.id,
  };
}

function paymentMeta(cart) {
  const first = Array.isArray(cart) ? cart[0] : null;
  return first && typeof first._payment === 'object' ? first._payment : {};
}

// ── OAuth token cache (warm-function reuse) ───────────────────────────────
let _tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken(host) {
  // Refresh 60s before actual expiry to avoid races
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
    // expires_in is seconds-from-now; expires_at is absolute epoch seconds
    expiresAt: data.expires_at ? data.expires_at * 1000 : Date.now() + (data.expires_in || 3300) * 1000,
  };
  return _tokenCache.token;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const clientId     = process.env.PHONEPE_CLIENT_ID;
  const clientSecret = process.env.PHONEPE_CLIENT_SECRET;
  const host         = process.env.PHONEPE_HOST || 'https://api.phonepe.com/apis';
  const siteUrl      = process.env.SITE_URL || 'https://inkandchai.in';

  if (!clientId || !clientSecret) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({
      error: 'PhonePe v2 credentials not configured. Set PHONEPE_CLIENT_ID + PHONEPE_CLIENT_SECRET in Netlify env vars (from PhonePe Business → Developer Settings → API Keys).'
    }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { cart: rawCart, customer, coupon, payment_mode } = body;
  if (!Array.isArray(rawCart) || !rawCart.length || !customer?.phone) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing cart or phone' }) };
  }

  // Re-derive prices + total server-side. NEVER trust client-supplied i.price.
  const _supabaseForCoupon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const priced = await resolveCartPrices(rawCart, _supabaseForCoupon);
  if (!priced.cart.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No catalogue items in cart' }) };
  }
  const cart        = priced.cart;
  const subtotal    = priced.subtotal;
  const shipping    = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE;
  let couponInfo    = await resolveCouponDiscount(_supabaseForCoupon, subtotal, coupon);
  const meta        = paymentMeta(cart);
  const isPartial   = payment_mode === 'partial_cod' || meta.mode === 'partial_cod';

  // Generate order id early so we can atomically claim a scratch card to it.
  const _now      = new Date();
  const _datePart = _now.toISOString().slice(0,10).replace(/-/g,'');
  const _randPart = Math.random().toString(36).slice(2,7).toUpperCase();
  const orderId   = `IC-${_datePart}-${_randPart}`;

  // Atomic scratch-card claim. If the same card is racing across multiple
  // concurrent checkouts, only one wins; the others drop the discount.
  if (couponInfo.source === 'scratch') {
    const claim = await claimScratchCardForOrder(_supabaseForCoupon, couponInfo.code, orderId);
    if (!claim.claimed) couponInfo = { code: '', discount: 0 };
  }

  const fullTotal   = Math.max(1, subtotal + shipping - (isPartial ? 0 : couponInfo.discount));
  const deposit     = isPartial ? Math.max(1, Math.ceil(fullTotal * 0.10)) : fullTotal;
  if (isPartial && cart[0]) {
    cart[0]._payment = {
      mode: 'partial_cod',
      full_total: fullTotal,
      deposit,
      balance: Math.max(0, fullTotal - deposit),
      rate: 0.10,
    };
  }
  // Stash the resolved coupon (incl. scratch-card source) on cart so payment-success
  // handlers can mark the card redeemed without re-validating.
  if (couponInfo.code && cart[0]) {
    cart[0]._coupon = {
      code: couponInfo.code,
      discount: couponInfo.discount,
      source: couponInfo.source || 'static',
    };
  }
  const amountPaise = Math.round(deposit * 100);
  if (amountPaise < 100) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Amount too low' }) };
  }

  // (orderId was generated above so the scratch-card claim could use it.)

  // ── 1. Save pending order to Supabase (non-fatal) ─────────────────────────
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { error: dbErr } = await supabase.from('orders').insert({
      razorpay_order_id:   orderId,
      razorpay_payment_id: null,
      amount_paise:        amountPaise,
      status:              isPartial ? 'pending_partial_phonepe' : 'pending_phonepe',
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

  // ── 2. Get OAuth token + create the payment ──────────────────────────────
  try {
    const token = await getAccessToken(host);

    const payload = {
      merchantOrderId: orderId,
      amount: amountPaise,
      expireAfter: 1200,           // 20 minutes for the customer to complete
      metaInfo: {
        udf1: customer.name?.slice(0, 80)  || '',
        udf2: customer.phone?.slice(0, 20) || '',
        udf3: customer.email?.slice(0, 80) || '',
        udf4: isPartial ? 'partial_cod' : (couponInfo.code || ''),
      },
      paymentFlow: {
        type: 'PG_CHECKOUT',
        message: `Ink & Chai order ${orderId}`,
        merchantUrls: {
          redirectUrl: `${siteUrl}/.netlify/functions/phonepe-verify-status?id=${encodeURIComponent(orderId)}`,
        },
      },
    };

    const res = await fetch(`${host}/pg/checkout/v2/pay`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'O-Bearer ' + token,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.redirectUrl) {
      console.error('PhonePe v2 pay error:', res.status, JSON.stringify(data));
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ error: 'PhonePe error: ' + (data.message || data.code || data.errorCode || ('HTTP ' + res.status)) }),
      };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        order_id: orderId,
        redirect_url: data.redirectUrl,
        phonepe_order_id: data.orderId,
      }),
    };

  } catch (err) {
    console.error('PhonePe network/auth error:', err);
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: err.message || 'PhonePe checkout failed' }),
    };
  }
};
