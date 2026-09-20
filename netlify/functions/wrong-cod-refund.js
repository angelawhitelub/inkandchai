/**
 * Netlify Function: wrong-cod-refund
 * POST /.netlify/functions/wrong-cod-refund   { id, q }
 *
 * The customer's own button for the wrong-COD double payment. Their parcel went
 * out labelled Cash on Delivery on an order they had already paid for online,
 * the agent collected a second time, and this hands that second payment back
 * without them having to ask anyone.
 *
 * PUBLIC, and gated exactly like track-order: the order id must be right AND
 * the email or phone must match what is on the order. That is the same bar that
 * already guards the address edit and the missing-book report on this page.
 *
 * Everything about WHETHER a refund may happen lives in utils/wrong-cod-refund,
 * shared with the WhatsApp bot. This file only establishes who is asking.
 *
 * Why the button waits for `delivered`: for a COD parcel the agent marks it
 * delivered when they hand it over, which for COD is when they have the cash.
 * It is the best signal we get without waiting a week for the remittance.
 */

const { createClient } = require('@supabase/supabase-js');
const { assess, performWrongCodRefund } = require('./utils/wrong-cod-refund');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
const rupees = (paise) => (Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Same identity test as track-order: email exact, or the last ten digits of the phone. */
function identifies(order, q) {
  const qn = norm(q);
  if (!qn) return false;
  if (order.customer_email && norm(order.customer_email) === qn) return true;
  const digits = qn.replace(/\D/g, '');
  return !!order.customer_phone && digits.length >= 10
    && norm(order.customer_phone).slice(-10) === digits.slice(-10);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }
  const id = String(body.id || '').trim();
  const q  = String(body.q || '').trim();
  if (!id || !q) return json(400, { error: 'Provide your order ID and the email or phone you ordered with.' });

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: order, error } = await supabase
      .from('orders').select('*').eq('razorpay_order_id', id).maybeSingle();
    if (error) throw error;
    if (!order) return json(404, { error: 'Order not found. Check the order ID and try again.' });
    if (!identifies(order, q)) {
      return json(403, { error: 'Email or phone does not match this order. Please use the same email/phone you used at checkout.' });
    }

    const before = assess(order);
    if (before.verdict === 'not-affected') {
      return json(400, { error: 'This order was not affected by the Cash-on-Delivery error, so there is nothing to refund here. If something else is wrong, message us on WhatsApp and we will sort it out.' });
    }
    if (before.verdict === 'already-done') {
      return json(200, {
        success: true, already: true, amount_rs: rupees(before.amountPaise), reference: before.ref,
        message: `₹${rupees(before.amountPaise)} has already been refunded to your original payment method. It reflects within 2–3 business days.`,
      });
    }
    if (before.verdict === 'manual-only') {
      return json(409, { error: `This was a free replacement, so there is no online payment of yours for us to reverse — we have to send the ₹${rupees(before.amountPaise)} to you by UPI instead. Message us on WhatsApp with your UPI ID and we will transfer it.` });
    }
    if (before.verdict === 'upi-route') {
      return json(200, {
        success: true, already: true, amount_rs: rupees(before.amountPaise),
        message: `You asked us to send the ₹${rupees(before.amountPaise)} to your UPI ID instead, and our team is transferring it there. Nothing more is needed from you.`,
      });
    }
    if (before.verdict === 'in-refund') {
      return json(200, { success: true, already: true, amount_rs: rupees(before.amountPaise), message: 'A refund on this order is already on its way to your original payment method.' });
    }
    if (before.verdict === 'not-delivered' || before.verdict === 'not-collected') {
      return json(409, { error: `This will unlock the moment your parcel is delivered. Please accept it and pay the ₹${rupees(before.amountPaise)} the delivery agent asks for — then tap this button and we will send that ₹${rupees(before.amountPaise)} straight back to the payment method you paid with.` });
    }

    const res = await performWrongCodRefund({ supabase, order, source: 'track-page' });
    if (res.verdict === 'already-done') {
      return json(200, { success: true, already: true, amount_rs: rupees(res.amountPaise), message: 'That refund is already being processed back to your original payment method.' });
    }
    if (res.verdict === 'no-payment-id' || res.verdict === 'disabled' || !res.ok) {
      // Never leave them thinking nothing happened. A human picks these up.
      console.error(`[wrong-cod-refund] ${id} not paid out: ${res.verdict}${res.error ? ` — ${res.error}` : ''}`);
      return json(502, { error: 'We could not put the refund through automatically just now. Our team has been alerted and will refund you — please message us on WhatsApp if you would like an update.' });
    }

    return json(200, {
      success: true,
      amount_rs: rupees(res.amountPaise),
      reference: res.ref,
      message: `₹${rupees(res.amountPaise)} is on its way back to the payment method you originally paid with. It normally reflects within 2–3 business days. We are sorry you were asked to pay twice — that was our mistake.`,
    });
  } catch (err) {
    console.error('[wrong-cod-refund]', err.message);
    return json(500, { error: 'Something went wrong at our end. Please message us on WhatsApp and we will refund you right away.' });
  }
};

exports.__test = { identifies };
