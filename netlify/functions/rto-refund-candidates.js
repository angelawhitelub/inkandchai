/**
 * Netlify Function: rto-refund-candidates
 * GET /.netlify/functions/rto-refund-candidates?days=90
 *
 * Read-only. Lists PREPAID orders that came back RTO and are still owed a
 * partial refund, with the shipping deduction already worked out.
 *
 * WHY A PARTIAL, AND WHY MANUAL
 * -----------------------------
 * When a prepaid parcel comes back undelivered we are out both legs of the
 * courier cost — ₹62 out and ₹62 back — so the customer is refunded what they
 * paid minus ₹124. The refund policy states this.
 *
 * This endpoint deliberately CANNOT move money. It only produces the list and
 * the arithmetic; issuing goes through the existing phonepe-refund /
 * razorpay-refund endpoints, one order at a time, from a button an admin
 * presses. RTO must never auto-refund: an RTO status can be set by a courier
 * webhook, and a webhook that fires wrongly would otherwise pay out on its own.
 *
 * WHAT COUNTS AS PREPAID
 * ----------------------
 * A recorded gateway payment id, and nothing softer. `shipment_payment_type`
 * is null on a large share of rows, and a COD order refunded by mistake is
 * money we never collected in the first place. Both refund endpoints also
 * refuse an order with no payment id, so this is belt and braces.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { parcelTier } = require('./utils/parcel-tier');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

/**
 * Shipping legs, in paise, per parcel tier.
 *
 * A single paperback (~250 g) bills in the courier's base slab at Rs 62 a leg.
 * A bundle -- "A + B", "Set of 5", a combo -- crosses ~500 g into the next slab
 * and costs more in BOTH directions, so refunding it at the base rate hands
 * back money we were actually charged. utils/parcel-tier decides which is which.
 *
 * The heavy default is twice the base leg. That is an ASSUMPTION, not a rate
 * card: set RTO_HEAVY_FORWARD_SHIPPING_PAISE / RTO_HEAVY_RETURN_SHIPPING_PAISE
 * to the real NimbusPost slab price, or override per-scan from the admin panel.
 */
const envPaise = (name, fallback) => Math.max(0, parseInt(process.env[name], 10) || fallback);
const FORWARD_SHIPPING_PAISE = envPaise('RTO_FORWARD_SHIPPING_PAISE', 6200);
const RETURN_SHIPPING_PAISE  = envPaise('RTO_RETURN_SHIPPING_PAISE', 6200);
const HEAVY_FORWARD_PAISE = envPaise('RTO_HEAVY_FORWARD_SHIPPING_PAISE', FORWARD_SHIPPING_PAISE * 2);
const HEAVY_RETURN_PAISE  = envPaise('RTO_HEAVY_RETURN_SHIPPING_PAISE', RETURN_SHIPPING_PAISE * 2);
const DEDUCTION_PAISE = FORWARD_SHIPPING_PAISE + RETURN_SHIPPING_PAISE;

// A rate supplied on the query string, so the admin can try their real slab
// prices without a redeploy. Clamped hard: a negative or absurd rate would
// silently inflate every refund on the page.
function rateParam(params, key, fallback) {
  const raw = params?.[key];
  if (raw == null || raw === '') return fallback;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 0 || n > 100000) return fallback;
  return n;
}

const PAGE = 1000;

/** Which gateway holds the money, from the shape of the payment id. */
function gatewayFor(paymentId) {
  const id = String(paymentId || '').trim();
  if (!id) return null;
  return id.startsWith('pay_') ? 'razorpay' : 'phonepe';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  const block = requireAdmin(event, CORS);
  if (block) return block;

  const params = event.queryStringParameters || {};
  const days = Math.min(Math.max(parseInt(params.days, 10) || 90, 1), 365);
  const sinceIso = new Date(Date.now() - days * 86400000).toISOString();

  const rates = {
    standard: rateParam(params, 'fwd', FORWARD_SHIPPING_PAISE) + rateParam(params, 'ret', RETURN_SHIPPING_PAISE),
    heavy:    rateParam(params, 'hfwd', HEAVY_FORWARD_PAISE)   + rateParam(params, 'hret', HEAVY_RETURN_PAISE),
  };
  const heavyAtBooks = Math.min(Math.max(parseInt(params.heavy_at, 10) || 2, 2), 20);

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Paginated: `.select()` silently caps at 1000 rows.
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('orders')
        .select('razorpay_order_id, razorpay_payment_id, amount_paise, status, created_at, '
              + 'customer_name, customer_phone, customer_email, cart_items, '
              + 'shipment_payment_type, tracking_id, courier_name, refund_id, refund_state, '
              + 'refund_updated_at, last_nimbuspost_status')
        .eq('status', 'rto')
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      rows.push(...data);
      if (data.length < PAGE) break;
    }

    let codSkipped = 0;
    const candidates = [];
    for (const order of rows) {
      const gateway = gatewayFor(order.razorpay_payment_id);
      if (!gateway) { codSkipped++; continue; }

      const gross = Math.round(Number(order.amount_paise) || 0);
      const cart = Array.isArray(order.cart_items) ? order.cart_items : [];
      const parcel = parcelTier(cart, { heavyAtBooks });
      const deduction = rates[parcel.tier];
      const refundPaise = Math.max(0, gross - deduction);
      candidates.push({
        order_id: order.razorpay_order_id,
        created_at: order.created_at,
        customer_name: order.customer_name || '',
        customer_phone: order.customer_phone || '',
        gateway,
        books: (Array.isArray(order.cart_items) ? order.cart_items : [])
          .map(i => i?.title).filter(Boolean).slice(0, 4),
        tracking_id: order.tracking_id || '',
        courier_name: order.courier_name || '',
        last_nimbuspost_status: order.last_nimbuspost_status || '',
        amount_paise: gross,
        deduction_paise: deduction,
        refund_paise: refundPaise,
        // Why this parcel was charged what it was, shown on the row so the
        // admin can see the reasoning before accepting or overriding the figure.
        parcel_tier: parcel.tier,
        parcel_books: parcel.books,
        parcel_reason: parcel.reason,
        // Nothing left after the deduction — the parcel cost more to move than
        // the customer paid. Shown, but not refundable.
        nothing_to_refund: refundPaise <= 0,
        // A refund was already attempted on this order. Surfaced rather than
        // hidden, so a stuck one is visible instead of silently dropping out.
        refund_started: Boolean(order.refund_id),
        refund_state: order.refund_state || null,
        refund_updated_at: order.refund_updated_at || null,
      });
    }

    const payable = candidates.filter(c => !c.nothing_to_refund && !c.refund_started);
    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        success: true,
        window_days: days,
        forward_shipping_paise: rateParam(params, 'fwd', FORWARD_SHIPPING_PAISE),
        return_shipping_paise: rateParam(params, 'ret', RETURN_SHIPPING_PAISE),
        heavy_forward_shipping_paise: rateParam(params, 'hfwd', HEAVY_FORWARD_PAISE),
        heavy_return_shipping_paise: rateParam(params, 'hret', HEAVY_RETURN_PAISE),
        deduction_paise: rates.standard,
        heavy_deduction_paise: rates.heavy,
        heavy_at_books: heavyAtBooks,
        heavy_count: candidates.filter(c => c.parcel_tier === 'heavy').length,
        rto_scanned: rows.length,
        cod_skipped: codSkipped,
        total: candidates.length,
        payable_count: payable.length,
        payable_paise: payable.reduce((sum, c) => sum + c.refund_paise, 0),
        candidates,
      }),
    };
  } catch (err) {
    console.error('[rto-refund-candidates]', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
