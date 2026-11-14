/**
 * Netlify Function: track-order
 * GET  /.netlify/functions/track-order?id=IC-20260430-AB3CD&q=customer-email-or-phone
 *
 * PUBLIC endpoint — anyone can call this. Returns sanitized order info
 * (status, items, courier, tracking_id, tracking_url) ONLY when:
 *   - the order_id matches AND
 *   - the supplied q (email or phone) matches what's on the order.
 *
 * This stops random people from looking up other customers' orders by
 * guessing order IDs.
 */

const { createClient } = require('@supabase/supabase-js');
const { canEditAddress } = require('./utils/address-editable');
const { resolveRefundRef, cleanRefundItems } = require('./utils/refund-notifications');
const { assess: assessWrongCod } = require('./utils/wrong-cod-refund');
const { isDefinitelyCod } = require('./utils/order-payment-kind');
const { findOrderByRef } = require('./utils/order-ref');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function norm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ''); }

/**
 * Refund details for the tracking page — the destination of the "View your
 * order" button on the refund WhatsApp/email, so it has to actually explain the
 * refund the customer was just told about.
 *
 * The amount is only ever reported when it is CERTAIN: the full order amount
 * for a full refund, or the sum of the recorded line items for a partial. There
 * is no refund-amount column, so a partial with no items recorded shows the
 * reference and the timeline but no figure — an unqualified number here is the
 * kind of thing a customer holds you to, and a guessed one would be worse than
 * none. `refund_pending` deliberately says "processing", never "issued": the
 * money has not left the gateway yet and may still fail.
 */
/**
 * The wrong-COD double payment, for the customer's own page.
 *
 * Only ever present on an order actually marked as affected, so an ordinary
 * order never sees a word about it. The button is live only once the parcel is
 * delivered: before that the customer has not paid twice, and offering a refund
 * they cannot have would read as a trick.
 */
function wrongCodView(data) {
  const v = assessWrongCod(data);
  if (v.verdict === 'not-affected') return {};
  return {
    wrong_cod: {
      amount: v.amountPaise / 100,
      state: v.verdict,
      can_refund: v.verdict === 'refundable',
      refunded_at: data.wrong_cod_refund_at || null,
      reference: data.wrong_cod_refund_ref && !/^failed /.test(data.wrong_cod_refund_ref) ? data.wrong_cod_refund_ref : null,
    },
  };
}

function refundView(data) {
  const status = String(data.status || '');
  const REFUND_STATUS = ['refunded', 'partially_refunded', 'refund_pending'];
  if (!REFUND_STATUS.includes(status)) return {};

  const items = cleanRefundItems(data.refund_items);
  const itemsPaise = items.reduce((s, i) => s + i.amount, 0) * 100;
  let refundPaise = null;
  if (status === 'refunded') refundPaise = Number(data.amount_paise) || null;
  else if (itemsPaise > 0)   refundPaise = itemsPaise;

  return {
    refund: {
      state:      status === 'refund_pending' ? 'processing' : 'issued',
      is_partial: status === 'partially_refunded',
      amount:     refundPaise ? refundPaise / 100 : null,
      reference:  resolveRefundRef(data, null),
      items:      items.map(i => ({ title: i.title, qty: i.qty, amount: i.amount })),
      at:         data.refund_updated_at || null,
    },
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const params = event.queryStringParameters || {};
  // Normalise order ID: strip ALL internal whitespace so "IC- 20260521-85YX6" → "IC-20260521-85YX6".
  // Do NOT uppercase — Razorpay's order_ IDs are case-sensitive (order_SsW3Rzrk7HkHdT).
  const id = (params.id || '').trim().replace(/\s+/g, '');
  const q  = (params.q  || '').trim();

  if (!id || !q) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide order id and email/phone' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // The order id, or just its 5-character short code (AB3CD), with the
    // email/phone on the order (utils/order-ref.js).
    const qn = norm(q);
    const qDigits = qn.replace(/\D/g, '');
    const owns = (o) => !!((o.customer_email && norm(o.customer_email) === qn)
      || (o.customer_phone && qDigits.length >= 10 && norm(o.customer_phone).replace(/\D/g, '').slice(-10) === qDigits.slice(-10)));
    const found = await findOrderByRef(supabase, id, owns);
    if (found.error) {
      console.error('track-order Supabase error:', found.error);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Database error: ' + found.error.message }) };
    }
    if (found.hint) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: found.hint, hint: 'date_only' }) };
    }
    const data = found.order;
    if (!data) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Order not found. Check the order ID (or its last 5 characters, e.g. AB3CD) and the email/phone you ordered with.' }) };
    }
    if (!found.owned) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Email or phone does not match this order. Please use the same email/phone you used at checkout.' }) };
    }

    // Sanitize before returning — mask phone, hide unrelated fields
    const phoneMasked = data.customer_phone
      ? data.customer_phone.replace(/\D/g, '').replace(/.(?=.{4})/g, '•').replace(/(.{4})/g, '$1 ')
      : '';
    const items = data.cart_items || [];
    const meta = Array.isArray(items) ? items[0]?._payment : null;
    const isPartial = meta?.mode === 'partial_cod' || data.status === 'partial_cod_pending';
    const isCOD = isPartial || !data.razorpay_payment_id;
    const paidNow = data.amount_paise ? (data.amount_paise / 100) : null;
    const total = isPartial ? (Number(meta?.full_total) || ((paidNow || 0) + (Number(meta?.balance) || 0))) : paidNow;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        order: {
          order_id:        data.razorpay_order_id,
          status:          data.status,
          name:            data.customer_name,
          phone_masked:    phoneMasked,
          address:         data.customer_address,
          can_edit_address: canEditAddress(data),
          address_updated:  !!data.address_updated_by_customer_at,
          items,
          total,
          paid_now:        paidNow,
          balance_due:     isPartial ? Number(meta?.balance) || 0 : 0,
          payment_method:  isPartial ? 'partial_cod' : (isCOD ? 'cod' : 'online'),
          // Whether the missing-book form must collect a refund UPI ID.
          // Deliberately NOT derived from payment_method above: that one is the
          // loose "no payment id" reading, used to label the total, while
          // report-missing-books enforces the strict isDefinitelyCod. Deriving
          // the field from the loose one lets the two disagree, and the direction
          // that hurts is a form that hides the field for an order the server
          // then refuses for not having it. Same function, same answer.
          refund_upi_required: isDefinitelyCod(data),
          placed_at:       data.created_at,
          shipped_at:      data.shipped_at,
          delivered_at:    data.delivered_at || null,
          // The replacement form: free replacements are not replaced again here.
          is_replacement:  String(data.source || '').toLowerCase() === 'replacement' || /^IC-R-/i.test(String(data.razorpay_order_id || '')),
          courier_name:    data.courier_name,
          tracking_id:     data.tracking_id,
          tracking_url:    data.tracking_url,
          ...refundView(data),
          ...wrongCodView(data),
        },
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
