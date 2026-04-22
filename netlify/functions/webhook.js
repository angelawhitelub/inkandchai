/**
 * Netlify Function: webhook
 * POST /.netlify/functions/webhook
 * Razorpay webhook endpoint — handles async payment events.
 * Register this URL in Razorpay Dashboard → Webhooks.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // ── 1. Verify webhook signature ───────────────────────────────────────────
  const receivedSig = event.headers['x-razorpay-signature'];
  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(event.body)
    .digest('hex');

  if (receivedSig !== expectedSig) {
    console.error('Webhook signature mismatch');
    return { statusCode: 403, body: 'Forbidden' };
  }

  // ── 2. Handle events ──────────────────────────────────────────────────────
  let payload;
  try { payload = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: 'Bad JSON' }; }

  const eventType = payload.event;
  const payment   = payload.payload?.payment?.entity;
  const orderId   = payment?.order_id;

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    switch (eventType) {

      case 'payment.authorized':
      case 'payment.captured':
        await supabase
          .from('orders')
          .upsert({ razorpay_order_id: orderId, status: 'paid', razorpay_payment_id: payment.id },
                  { onConflict: 'razorpay_order_id' });
        console.log(`✓ Payment captured: ${payment.id}`);
        break;

      case 'payment.failed':
        await supabase
          .from('orders')
          .update({ status: 'failed' })
          .eq('razorpay_order_id', orderId);
        console.log(`✗ Payment failed: ${orderId}`);
        break;

      case 'refund.created':
        await supabase
          .from('orders')
          .update({ status: 'refunded' })
          .eq('razorpay_order_id', orderId);
        break;

      default:
        console.log(`Unhandled event: ${eventType}`);
    }
  } catch (err) {
    console.error('DB update error:', err.message);
    // Still return 200 so Razorpay doesn't retry endlessly
  }

  return { statusCode: 200, body: 'OK' };
};
