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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

/** Forward shipping + return leg, in paise. Overridable, but this is the rate. */
const FORWARD_SHIPPING_PAISE = Math.max(0, parseInt(process.env.RTO_FORWARD_SHIPPING_PAISE, 10) || 6200);
const RETURN_SHIPPING_PAISE  = Math.max(0, parseInt(process.env.RTO_RETURN_SHIPPING_PAISE, 10) || 6200);
const DEDUCTION_PAISE = FORWARD_SHIPPING_PAISE + RETURN_SHIPPING_PAISE;

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

  const days = Math.min(Math.max(parseInt(event.queryStringParameters?.days, 10) || 90, 1), 365);
  const sinceIso = new Date(Date.now() - days * 86400000).toISOString();

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
      const refundPaise = Math.max(0, gross - DEDUCTION_PAISE);
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
        deduction_paise: DEDUCTION_PAISE,
        refund_paise: refundPaise,
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
        forward_shipping_paise: FORWARD_SHIPPING_PAISE,
        return_shipping_paise: RETURN_SHIPPING_PAISE,
        deduction_paise: DEDUCTION_PAISE,
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
