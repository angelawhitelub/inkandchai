/**
 * Netlify Function: create-order
 * POST /.netlify/functions/create-order
 *
 * Body: { cart, customer?, coupon?, payment_mode? }
 *   - cart:         [{ url|id|slug, qty }, ...]
 *   - coupon:       optional coupon code (validated server-side)
 *   - payment_mode: 'partial_cod' charges only 10% deposit; otherwise full
 *
 * Returns the Razorpay order { id, amount, currency } with amount RECOMPUTED
 * server-side from the canonical catalogue. The browser-supplied `price` on
 * cart items is ignored. (Previously the function trusted client `amount`,
 * which let an attacker pay ₹1 for a ₹799 order.)
 */

const Razorpay = require('razorpay');
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

const COUPONS = {
  INKLOVE10:  { type: 'percent', value: 10, minSubtotal: 499  },
  '499HIT':   { type: 'percent', value: 10, minSubtotal: 499  },
  SAVE12:     { type: 'percent', value: 12, minSubtotal: 999  },
  SAVE15:     { type: 'percent', value: 15, minSubtotal: 1499 },
  CHAI10BACK: { type: 'percent', value: 10, minSubtotal: 299  },
};

function normalizeCouponCode(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function staticCouponDiscount(subtotal, rawCode) {
  const code = normalizeCouponCode(rawCode);
  const c = COUPONS[code];
  if (!c || subtotal < c.minSubtotal) return { code: '', discount: 0 };
  const discount = c.type === 'percent'
    ? Math.floor(subtotal * c.value / 100)
    : Math.floor(c.value);
  return { code, discount: Math.max(0, discount) };
}

async function resolveCoupon(supabase, subtotal, rawCode) {
  const staticHit = staticCouponDiscount(subtotal, rawCode);
  if (staticHit.discount > 0) return { ...staticHit, source: 'static' };

  const scratchCode = String(rawCode || '').toUpperCase().trim();
  if (!scratchCode.startsWith('SCRATCH-')) return { code: '', discount: 0 };

  const { data: card } = await supabase
    .from('scratch_cards').select('*').eq('code', scratchCode).maybeSingle();
  if (!card)                                            return { code: '', discount: 0 };
  if (card.status !== 'scratched')                      return { code: '', discount: 0 };
  if (new Date(card.expires_at) < new Date())           return { code: '', discount: 0 };
  if (subtotal * 100 < (card.min_subtotal_paise || 0)) return { code: '', discount: 0 };
  return {
    code: scratchCode,
    discount: Math.round((card.value_paise || 0) / 100),
    source: 'scratch',
    scratch_card_id: card.id,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { cart: rawCart, coupon: rawCoupon, payment_mode, customer, notes: clientNotes } = body;
  if (!Array.isArray(rawCart) || !rawCart.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Cart is required' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // ── Authoritative pricing ───────────────────────────────────────────────
    const { cart, subtotal, dropped } = await resolveCartPrices(rawCart, supabase);
    if (!cart.length) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({
        error: 'No catalogue items in cart',
        dropped,
      }) };
    }

    const shipping   = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE;
    const couponInfo = await resolveCoupon(supabase, subtotal, rawCoupon);
    const isPartial  = payment_mode === 'partial_cod';
    const fullTotal  = Math.max(1, subtotal + shipping - (isPartial ? 0 : couponInfo.discount));
    const charged    = isPartial ? Math.max(1, Math.ceil(fullTotal * 0.10)) : fullTotal;
    const amountPaise = Math.round(charged * 100);

    if (amountPaise < 100) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Amount too low' }) };
    }

    const razorpay = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const safeNotes = (clientNotes && typeof clientNotes === 'object') ? clientNotes : {};

    // Create the Razorpay order first, then atomically claim the scratch card
    // (if any). If the claim races and loses, recreate the order at full price
    // — better than letting one card discount N parallel carts.
    let finalAmountPaise   = amountPaise;
    let finalCouponCode    = couponInfo.code || '';
    let finalDiscountPaise = Math.round((isPartial ? 0 : couponInfo.discount) * 100);
    if (couponInfo.source === 'scratch') {
      // Two-step claim: provisional id now, rewrite to real razorpay order id
      // once create() returns. Race-safe at the DB level (see scratch-cards.js).
      const provisionalId = `provisional_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      const claim = await claimScratchCardForOrder(supabase, couponInfo.code, provisionalId);
      if (!claim.claimed) {
        finalDiscountPaise = 0;
        finalCouponCode    = '';
        const reFull       = Math.max(1, subtotal + shipping);
        const reCharged    = isPartial ? Math.max(1, Math.ceil(reFull * 0.10)) : reFull;
        finalAmountPaise   = Math.round(reCharged * 100);
      } else {
        couponInfo._provisionalId = provisionalId;
      }
    }

    const order = await razorpay.orders.create({
      amount:   finalAmountPaise,
      currency: 'INR',
      receipt:  `ic_${Date.now()}`,
      notes: {
        ...safeNotes,
        server_subtotal_paise:   Math.round(subtotal * 100),
        server_shipping_paise:   Math.round(shipping  * 100),
        server_discount_paise:   finalDiscountPaise,
        server_amount_paise:     finalAmountPaise,
        server_full_total_paise: Math.round(fullTotal * 100),
        server_payment_mode:     isPartial ? 'partial_cod' : 'full',
        server_coupon_code:      finalCouponCode,
      },
    });

    // Re-tag the scratch-card claim with the real razorpay order id.
    if (couponInfo._provisionalId) {
      await supabase
        .from('scratch_cards')
        .update({ redeemed_order_id: order.id })
        .eq('redeemed_order_id', couponInfo._provisionalId);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        id:       order.id,
        amount:   order.amount,
        currency: order.currency,
        // Echo the authoritative cart so the browser can refresh its display
        // (and any drift is visible to the user before they pay).
        server_cart: cart,
        server_total: charged,
        server_full_total: fullTotal,
        server_subtotal: subtotal,
        server_shipping: shipping,
        server_discount: isPartial ? 0 : couponInfo.discount,
        server_coupon: couponInfo.code || '',
        payment_mode: isPartial ? 'partial_cod' : 'full',
      }),
    };

  } catch (err) {
    console.error('create-order error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Failed to create order', details: err.message }),
    };
  }
};
