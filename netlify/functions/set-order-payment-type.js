/**
 * Netlify Function: set-order-payment-type
 * POST /.netlify/functions/set-order-payment-type
 *
 * Admin endpoint — manually switch an order between COD and Prepaid.
 * The admin panel derives "COD vs Online" from status + payment_status +
 * razorpay_payment_id, so this writes those consistently:
 *
 *   payment_type 'cod'                 → status cod_pending, payment_status null,
 *                                        razorpay_payment_id cleared (if it was a
 *                                        manual prepaid marker, not a real gateway id)
 *   payment_type 'prepaid', collected  → status paid, payment_status 'paid'
 *   payment_type 'prepaid', !collected → status confirmed, payment_status 'prepaid_pending'
 *
 * Body: { id: <orders.id>, payment_type: 'cod'|'prepaid', collected?: boolean }
 * Headers: X-Admin-Token / X-Admin-Key.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { isReplacementOrder } = require('./utils/replacement-order');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-Admin-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase env vars missing' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const id = String(body.id || '').trim();
  const orderRef = String(body.order_ref || '').trim();   // IC- display id (razorpay_order_id)
  const paymentType = body.payment_type === 'prepaid' ? 'prepaid' : body.payment_type === 'cod' ? 'cod' : '';
  const collected = body.collected === true;
  if (!id && !orderRef) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide order id' }) };
  if (!paymentType) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'payment_type must be cod or prepaid' }) };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    // NOTE: do NOT select payment_status — that column doesn't exist on this
    // table, and selecting a missing column errors the whole query, which the
    // lookup below then misreads as "order not found" (was a 404 on EVERY
    // toggle). The UPDATE keeps a retry-without-payment_status fallback for the
    // same reason.
    const SEL = 'id, razorpay_order_id, status, razorpay_payment_id, source, cart_items, amount_paise, tracking_id, shipment_payment_type';

    // Locate the order by ANY identifier we were given, robust to:
    //  - the PK type (uuid or bigint) — we just query `id` directly; if `id` is
    //    an IC- string and the column is uuid, PostgREST returns a cast error
    //    which we ignore (order stays null) rather than letting it 404,
    //  - the client version — older cached admin JS sends only `id` (no
    //    order_ref), so we also try `id` against razorpay_order_id.
    let order = null;
    const tryEq = async (col, val) => {
      if (order || !val) return;
      const r = await supabase.from('orders').select(SEL).eq(col, val).maybeSingle();
      if (!r.error && r.data) order = r.data;
    };
    await tryEq('id', id);                     // uuid or bigint PK
    await tryEq('razorpay_order_id', orderRef); // IC- display id (new client)
    await tryEq('razorpay_order_id', id);       // in case `id` IS the IC- display id
    if (!order) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: `Order not found (id="${id}", ref="${orderRef}")` }) };
    }

    // A replacement is never a new sale. It must not be converted to COD,
    // otherwise the courier may collect the original book value a second time.
    if (isReplacementOrder(order)) {
      if (paymentType === 'cod') {
        return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'Replacement orders are always prepaid and cannot be changed to COD.' }) };
      }
      const replacementStatus = order.tracking_id
        ? order.status
        : (['paid', 'confirmed', 'cod_pending', 'partial_cod_pending'].includes(String(order.status || '').toLowerCase())
          ? 'replacement_pending'
          : order.status);
      const patch = {
        shipment_payment_type: 'prepaid',
        status: replacementStatus || 'replacement_pending',
      };
      const { error } = await supabase.from('orders').update(patch).eq('id', order.id);
      if (error) throw error;
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, id: order.id, status: patch.status, payment_status: null, razorpay_payment_id: order.razorpay_payment_id, shipment_payment_type: 'prepaid' }),
      };
    }

    // Don't clobber a REAL gateway payment (pay_… / PhonePe id). Only manual
    // markers (plink:… / prepaid:… / null) are safe to rewrite.
    const existingPid = String(order.razorpay_payment_id || '');
    const isRealGatewayPid = /^pay_/.test(existingPid) || (existingPid && !/^(plink:|prepaid:)/.test(existingPid) && !order.payment_status);

    const patch = {};
    if (paymentType === 'cod') {
      patch.status = 'cod_pending';
      patch.payment_status = null;
      if (!isRealGatewayPid) patch.razorpay_payment_id = null;
    } else if (collected) {
      patch.status = 'paid';
      patch.payment_status = 'paid';
      if (!existingPid) patch.razorpay_payment_id = `prepaid:${id}`;
    } else {
      patch.status = 'confirmed';
      patch.payment_status = 'prepaid_pending';
      if (!isRealGatewayPid) patch.razorpay_payment_id = null;
    }

    // payment_status is a newer column — retry without it if the write fails.
    let { error } = await supabase.from('orders').update(patch).eq('id', order.id);
    if (error) {
      const { payment_status, ...rest } = patch;
      const retry = await supabase.from('orders').update(rest).eq('id', order.id);
      if (retry.error) throw retry.error;
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, id: order.id, status: patch.status, payment_status: patch.payment_status ?? null, razorpay_payment_id: ('razorpay_payment_id' in patch ? patch.razorpay_payment_id : order.razorpay_payment_id) }),
    };
  } catch (err) {
    console.error('set-order-payment-type error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
