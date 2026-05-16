/**
 * Netlify Function: cancel-order
 * POST /.netlify/functions/cancel-order
 *
 * Unified customer-facing cancellation endpoint for both COD and prepaid orders.
 *
 * COD orders  (cod_pending / partial_cod_pending / confirmed):
 *   → Marks as "cancelled". No refund needed.
 *
 * Prepaid orders (status "paid") within 30 minutes of creation:
 *   → Issues full Razorpay refund (if razorpay_payment_id starts with "pay_").
 *   → For PhonePe / unknown IDs: marks as "refund_pending", emails admin.
 *   → Sends cancellation + refund confirmation email to customer.
 *
 * Security: validates JWT, confirms order ownership by email.
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const COD_CANCELLABLE   = ['cod_pending', 'partial_cod_pending', 'confirmed'];
const FINAL_STATUSES    = ['shipped', 'out_for_delivery', 'delivered', 'cancelled', 'refunded', 'refund_pending'];
const PREPAID_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// ── Email helper ─────────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return;
  async function attempt(from) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  }
  try {
    let r = await attempt('Ink & Chai <support@inkandchai.in>');
    if (!r.ok && (r.status === 403 || /domain|verified|not.*allowed|testing/i.test(r.body?.message || ''))) {
      r = await attempt('Ink & Chai <onboarding@resend.dev>');
    }
    if (!r.ok) console.error('Resend error:', r.status, JSON.stringify(r.body));
  } catch (e) { console.error('sendEmail error:', e.message); }
}

// ── Email templates ──────────────────────────────────────────────────────────
function cancellationEmailHtml(order, refundNote) {
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const total = order.amount_paise ? (order.amount_paise / 100) : 0;
  const rows = items.map(i => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;">${i.title || ''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;text-align:center;">${i.qty}</td>
    </tr>`).join('');
  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">inkandchai.in</p>
      <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">Order Cancelled</h2>
      <p style="color:#a09080;line-height:1.8;margin:14px 0;">
        Hi ${order.customer_name?.split(' ')[0] || 'there'}, your order has been cancelled as requested.
      </p>
      ${refundNote ? `<div style="background:#1c1916;border-left:3px solid #6dbf6d;padding:14px 18px;margin:16px 0;">
        <p style="color:#6dbf6d;margin:0;font-size:14px;">${refundNote}</p>
      </div>` : ''}
      <p style="color:#a09080;font-size:13px;">Order ID: <strong style="color:#c9a84c;">${order.razorpay_order_id || order.id}</strong></p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
        <thead><tr style="background:#1c1916;">
          <th style="padding:8px 12px;text-align:left;color:#c9a84c;font-weight:500;">Book</th>
          <th style="padding:8px 12px;text-align:center;color:#c9a84c;font-weight:500;">Qty</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${total ? `<p style="color:#a09080;font-size:13px;">Order total: <strong style="color:#f0e8d8;">₹${total.toLocaleString('en-IN')}</strong></p>` : ''}
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#a09080;font-size:13px;line-height:1.8;">
        Questions? Reply to this email or WhatsApp us. <a href="https://inkandchai.in" style="color:#c9a84c;">Browse catalogue →</a>
      </p>
      <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai · support@inkandchai.in</p>
    </div>`;
}

function adminRefundEmailHtml(order) {
  const total = order.amount_paise ? (order.amount_paise / 100) : 0;
  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#e87070;font-size:20px;font-weight:400;margin-bottom:4px;">⚠ Manual Refund Required</h1>
      <p style="color:#a09080;line-height:1.8;margin:14px 0;">
        A customer cancelled a prepaid order. The payment gateway did not support auto-refund. Please process manually.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:6px 0;color:#a09080;">Order ID</td><td style="color:#c9a84c;">${order.razorpay_order_id || order.id}</td></tr>
        <tr><td style="padding:6px 0;color:#a09080;">Payment ID</td><td style="color:#c9a84c;">${order.razorpay_payment_id || '—'}</td></tr>
        <tr><td style="padding:6px 0;color:#a09080;">Customer</td><td style="color:#f0e8d8;">${order.customer_name} &lt;${order.customer_email}&gt;</td></tr>
        <tr><td style="padding:6px 0;color:#a09080;">Amount</td><td style="color:#f0e8d8;">₹${total.toLocaleString('en-IN')}</td></tr>
      </table>
    </div>`;
}

// ── Razorpay refund ──────────────────────────────────────────────────────────
async function issueRazorpayRefund(paymentId, amountPaise) {
  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error('Razorpay credentials not configured');

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const res = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}/refund`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: amountPaise, // full refund
      speed: 'normal',     // 5-7 business days; use 'optimum' for instant (extra fee)
      notes: { reason: 'Customer cancelled within 30 minutes of order' },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.description || `Razorpay error ${res.status}`);
  return data; // { id, amount, status, ... }
}

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const SUPABASE_URL         = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Auth ─────────────────────────────────────────────────────────────────
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Not authenticated' }) };

  let userEmail;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user?.email) throw new Error('Invalid token');
    userEmail = user.email.toLowerCase();
  } catch {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session. Please sign in again.' }) };
  }

  // ── Parse body ───────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { order_id } = body;
  if (!order_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing order_id' }) };

  // ── Fetch & verify ownership ─────────────────────────────────────────────
  const { data: order, error: fetchErr } = await supabase
    .from('orders').select('*').eq('id', order_id).maybeSingle();

  if (fetchErr || !order)
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Order not found' }) };

  if ((order.customer_email || '').toLowerCase() !== userEmail)
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'You do not have permission to cancel this order' }) };

  const status = String(order.status || '').toLowerCase();

  // Already in a terminal state
  if (FINAL_STATUSES.includes(status)) {
    const msg = status === 'cancelled'     ? 'This order is already cancelled.' :
                status === 'refunded'      ? 'This order is already refunded.' :
                status === 'refund_pending'? 'Your refund is already being processed.' :
                ['shipped','out_for_delivery'].includes(status)
                  ? 'This order has already shipped. Please use the return option after delivery.'
                  : 'This order cannot be cancelled at this stage.';
    return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: msg }) };
  }

  // ── Case 1: COD order ────────────────────────────────────────────────────
  if (COD_CANCELLABLE.includes(status)) {
    await supabase.from('orders').update({ status: 'cancelled' }).eq('id', order_id);
    if (order.customer_email) {
      await sendEmail({
        to: order.customer_email,
        subject: `Order cancelled — ${order.razorpay_order_id || order.id}`,
        html: cancellationEmailHtml(order, null),
      });
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, type: 'cod', message: 'Order cancelled successfully.' }) };
  }

  // ── Case 2: Prepaid order (status "paid") — 30-minute window ────────────
  if (status === 'paid') {
    const createdAt  = order.created_at ? new Date(order.created_at).getTime() : 0;
    const ageMs      = Date.now() - createdAt;
    const minutesAgo = Math.floor(ageMs / 60000);

    if (ageMs > PREPAID_WINDOW_MS) {
      return {
        statusCode: 422, headers: CORS,
        body: JSON.stringify({ error: `Prepaid orders can only be cancelled within 30 minutes of placing. This order was placed ${minutesAgo} minutes ago.` }),
      };
    }

    const paymentId = order.razorpay_payment_id || '';
    let refundNote, newStatus, refundId;

    // Razorpay payments start with "pay_"
    if (paymentId.startsWith('pay_')) {
      try {
        const refund = await issueRazorpayRefund(paymentId, order.amount_paise);
        refundId  = refund.id;
        newStatus = 'refunded';
        refundNote = `💳 Refund of ₹${(order.amount_paise / 100).toLocaleString('en-IN')} has been initiated. It will appear in your account within 5–7 business days (Refund ID: ${refundId}).`;
      } catch (err) {
        console.error('Razorpay refund failed:', err.message);
        newStatus = 'refund_pending';
        refundNote = `⏳ Your refund of ₹${(order.amount_paise / 100).toLocaleString('en-IN')} is being processed manually and will reach you within 3–5 business days.`;
      }
    } else {
      // PhonePe or unknown — flag for manual processing
      newStatus = 'refund_pending';
      refundNote = `⏳ Your refund of ₹${(order.amount_paise / 100).toLocaleString('en-IN')} is being processed and will reach you within 3–5 business days.`;
    }

    await supabase.from('orders').update({ status: newStatus }).eq('id', order_id);

    // Email customer
    if (order.customer_email) {
      await sendEmail({
        to: order.customer_email,
        subject: `Order cancelled & refund initiated — ${order.razorpay_order_id || order.id}`,
        html: cancellationEmailHtml(order, refundNote),
      });
    }

    // Email admin for manual refunds
    if (newStatus === 'refund_pending') {
      const adminEmail = process.env.ADMIN_EMAIL || 'support@inkandchai.in';
      await sendEmail({
        to: adminEmail,
        subject: `⚠ Manual refund needed — ${order.razorpay_order_id || order.id}`,
        html: adminRefundEmailHtml(order),
      });
    }

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        success: true, type: 'prepaid', status: newStatus,
        message: newStatus === 'refunded'
          ? `Order cancelled. Refund of ₹${(order.amount_paise / 100).toLocaleString('en-IN')} initiated (5–7 business days).`
          : `Order cancelled. Refund will be processed manually within 3–5 business days.`,
      }),
    };
  }

  return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: 'This order cannot be cancelled.' }) };
};
