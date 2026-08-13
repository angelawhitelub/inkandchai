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
const { pincodeRejection } = require('./utils/pincode-valid');
const { findShippingRestriction } = require('./utils/shipping-restrictions');
const { resolveProductCoupon } = require('./utils/product-coupons');
const { freedomSaleDiscount } = require('./utils/freedom-sale');

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

async function resolveCoupon(supabase, cart, subtotal, rawCode) {
  // Independence Day offer is automatic, applies to every payment mode, and
  // replaces rather than stacks with any manually selected coupon.
  const freedomHit = freedomSaleDiscount(subtotal);
  if (freedomHit.discount > 0) return freedomHit;

  const staticHit = staticCouponDiscount(subtotal, rawCode);
  if (staticHit.discount > 0) return { ...staticHit, source: 'static' };

  const productHit = await resolveProductCoupon(supabase, cart, rawCode);
  if (productHit.discount > 0) return productHit;

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

  // Reject junk pincodes (123456 …) AND pincodes India Post has no record of,
  // before we spend a Razorpay order on them. The browser checks this too, but
  // that check is a 500ms debounce the customer can out-click — this is the gate
  // that decides. Fails open on a missing pincode or an unreachable lookup.
  {
    const bad = await pincodeRejection(customer);
    if (bad) return { statusCode: 400, headers: CORS, body: JSON.stringify(bad) };
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

    const shippingRestriction = findShippingRestriction(cart, customer || {});
    if (shippingRestriction.blocked) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify(shippingRestriction) };
    }

    const shipping   = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE;
    const couponInfo = await resolveCoupon(supabase, cart, subtotal, rawCoupon);
    const isPartial  = payment_mode === 'partial_cod';
    const partialDiscount = couponInfo.source === 'freedom_sale' ? couponInfo.discount : 0;
    const appliedDiscount = isPartial ? partialDiscount : couponInfo.discount;
    const fullTotal  = Math.max(1, subtotal + shipping - appliedDiscount);
    const charged    = isPartial ? Math.max(1, Math.ceil(fullTotal * 0.10)) : fullTotal;
    const amountPaise = Math.round(charged * 100);

    if (amountPaise < 100) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Amount too low' }) };
    }

    // ── Price re-check ───────────────────────────────────────────────────────
    // If the ORDER TOTAL the customer was shown differs from the authoritative
    // server total (a book's price changed after the static storefront page was
    // built), DON'T charge — return the corrected total so the storefront shows
    // it and lets the customer confirm. Backward-compatible: only runs when the
    // client sends expected_total.
    const expectedTotal = Number(body.expected_total);
    if (Number.isFinite(expectedTotal) && Math.round(expectedTotal) !== Math.round(fullTotal)) {
      console.log(`[PRICE-RECHECK] razorpay shown ₹${Math.round(expectedTotal)} vs server ₹${Math.round(fullTotal)}`);
      return {
        statusCode: 409,
        headers: CORS,
        body: JSON.stringify({
          price_changed: true,
          correct_total: Math.round(fullTotal),
          breakdown: {
            subtotal: Math.round(subtotal),
            shipping,
            discount: appliedDiscount,
            coupon: couponInfo.code || '',
            total: Math.round(fullTotal),
          },
          lines: cart.map(i => ({ slug: i.slug || '', title: i.title || '', price: i.price, qty: i.qty })),
          message: `Some prices were updated. Your new total is ₹${Math.round(fullTotal).toLocaleString('en-IN')}.`,
        }),
      };
    }

    const razorpay = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const safeNotes = (clientNotes && typeof clientNotes === 'object') ? clientNotes : {};

    // Build the item list from the AUTHORITATIVE server-resolved cart, never the
    // client's `books` note. The browser sends cart items as { url|id|slug, qty }
    // — most carry no title — so the client-built `books` string silently dropped
    // every line whose title was missing, collapsing multi-book orders to one.
    // Include quantities so a qty>1 line can't read as a single copy downstream.
    const serverBooks = cart
      .map(i => (Number(i.qty) > 1 ? `${i.title} ×${i.qty}` : i.title))
      .filter(Boolean)
      .join(', ')
      .slice(0, 480);   // Razorpay note values cap ~512 chars; the full cart is
                        // persisted to order_carts below, so truncation here is cosmetic.

    // Create the Razorpay order first, then atomically claim the scratch card
    // (if any). If the claim races and loses, recreate the order at full price
    // — better than letting one card discount N parallel carts.
    let finalAmountPaise   = amountPaise;
    let finalCouponCode    = couponInfo.code || '';
    let finalDiscountPaise = Math.round(appliedDiscount * 100);
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
        // Authoritative item list — overrides any client-supplied `books` note.
        books:                   serverBooks || safeNotes.books || '',
        server_subtotal_paise:   Math.round(subtotal * 100),
        server_shipping_paise:   Math.round(shipping  * 100),
        server_discount_paise:   finalDiscountPaise,
        server_amount_paise:     finalAmountPaise,
        server_full_total_paise: Math.round(fullTotal * 100),
        server_payment_mode:     isPartial ? 'partial_cod' : 'full',
        server_coupon_code:      finalCouponCode,
      },
    });

    // ── Persist the authoritative cart, keyed by the Razorpay order id ────────
    // This is the durable source of truth for line items. If the browser's
    // verify-payment callback never fires, razorpay-webhook.js reads this back
    // so the real books (and quantities) survive instead of being rebuilt as a
    // single placeholder line. Best-effort: never let a snapshot failure block a
    // paid order. Requires sql/order_carts.sql (silently no-ops until it's run).
    try {
      const c = (customer && typeof customer === 'object') ? customer : {};
      await supabase.from('order_carts').upsert({
        razorpay_order_id: order.id,
        cart_items:        cart,
        subtotal_paise:    Math.round(subtotal * 100),
        amount_paise:      finalAmountPaise,
        full_total_paise:  Math.round(fullTotal * 100),
        coupon_code:       finalCouponCode || null,
        payment_mode:      isPartial ? 'partial_cod' : 'full',
        customer: {
          name:    c.name    || safeNotes.customer_name  || '',
          email:   c.email   || safeNotes.customer_email || '',
          phone:   c.phone   || safeNotes.customer_phone || '',
          address: c.address || safeNotes.shipping_address || '',
        },
      }, { onConflict: 'razorpay_order_id' });
    } catch (snapErr) {
      console.warn('[create-order] order_carts snapshot skipped (run sql/order_carts.sql):', snapErr.message);
    }

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
        server_discount: appliedDiscount,
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
