/**
 * Netlify Function: ebook-verify-payment
 * POST { razorpay_order_id, razorpay_payment_id, razorpay_signature } → { ok, slug }
 *
 * Turns a completed Razorpay payment into an entitlement.
 *
 * THREE CHECKS, AND WHY EACH ONE IS THERE
 *
 * 1. The signature proves Razorpay issued this payment, not the browser.
 *
 * 2. The slug is read from the Razorpay ORDER's notes, never from the request.
 *    verify-payment.js learned this the expensive way with amounts: anything
 *    the client sends, the client can change. Taking the slug from the request
 *    would let someone buy the ₹49 title and redeem the ₹499 one.
 *
 * 3. The order's notes.user_id must be the caller. Without it, a customer who
 *    somehow saw another person's payment ids could grant the book to
 *    themselves; with it, the entitlement can only land on the account that
 *    opened the order.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { requireCustomer } = require('./utils/customer-auth');
const { grantEbook } = require('./utils/ebook-grant');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

async function fetchRazorpayOrder(orderId) {
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const res = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Razorpay order fetch failed (${res.status})`);
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const who = await requireCustomer(event, db);
  if (who.error) return json(who.status, { error: who.error });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return json(400, { error: 'Incomplete payment details.' });
  }

  // ── 1. Signature ────────────────────────────────────────────────────────
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  if (expected !== razorpay_signature) {
    console.error('[ebook-verify-payment] signature mismatch', razorpay_order_id);
    return json(400, { error: 'Payment could not be verified.' });
  }

  try {
    // ── 2 & 3. What was actually bought, and by whom ──────────────────────
    const order = await fetchRazorpayOrder(razorpay_order_id);
    const notes = order.notes || {};
    if (notes.kind !== 'ebook' || !notes.slug) {
      return json(400, { error: 'That payment was not for an eBook.' });
    }
    if (notes.user_id !== who.user.id) {
      console.error('[ebook-verify-payment] user mismatch', razorpay_order_id);
      return json(403, { error: 'That payment belongs to a different account.' });
    }

    const granted = await grantEbook(db, {
      slug: notes.slug,
      userId: who.user.id,
      email: who.user.email,
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      amountPaise: Number(order.amount) || 0,
    });
    if (!granted.ok) {
      // They have paid. Say so plainly rather than implying the payment failed,
      // and leave a log line with the payment id so it can be granted by hand.
      console.error('[ebook-verify-payment] grant failed', razorpay_payment_id, granted.error);
      return json(500, {
        error: 'Your payment went through but we could not unlock the book. '
             + 'Message us on WhatsApp with this reference and we will fix it: ' + razorpay_payment_id,
      });
    }

    return json(200, { ok: true, slug: notes.slug, title: notes.title || '' });
  } catch (e) {
    console.error('[ebook-verify-payment]', e.message);
    return json(502, { error: 'Could not confirm the payment with Razorpay. If money has left your account, message us on WhatsApp.' });
  }
};
