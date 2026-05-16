/**
 * Netlify Function: cancel-order
 * POST /.netlify/functions/cancel-order
 *
 * Allows an authenticated customer to cancel their own COD/partial-COD order
 * before it has been shipped. Validates JWT, confirms order ownership, and
 * only permits cancellation of orders in a pre-dispatch state.
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

// Statuses that a customer is allowed to cancel
const CANCELLABLE_STATUSES = ['cod_pending', 'partial_cod_pending', 'confirmed'];

// Statuses that are already past the point of no return
const FINAL_STATUSES = ['shipped', 'out_for_delivery', 'delivered', 'cancelled', 'refunded'];

async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return;
  async function attempt(from) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
    return { ok: res.ok };
  }
  try {
    let r = await attempt('Ink & Chai <support@inkandchai.in>');
    if (!r.ok) await attempt('Ink & Chai <onboarding@resend.dev>');
  } catch (e) { console.error('sendEmail error:', e.message); }
}

function cancellationEmailHtml(order) {
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
        Hi ${order.customer_name?.split(' ')[0] || 'there'}, your order has been cancelled as requested. No payment was collected.
      </p>
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
        Want to order again? <a href="https://inkandchai.in" style="color:#c9a84c;">Browse our catalogue →</a>
      </p>
      <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai · For any questions reply to this email or message us on WhatsApp.</p>
    </div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const SUPABASE_URL         = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Authenticate user ────────────────────────────────────────────────────
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Not authenticated' }) };

  let userEmail = null;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user?.email) throw new Error('Invalid token');
    userEmail = user.email.toLowerCase();
  } catch (e) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session. Please sign in again.' }) };
  }

  // ── Parse body ───────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { order_id } = body;
  if (!order_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing order_id' }) };

  // ── Fetch order and verify ownership ────────────────────────────────────
  const { data: order, error: fetchErr } = await supabase
    .from('orders')
    .select('*')
    .eq('id', order_id)
    .maybeSingle();

  if (fetchErr || !order) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Order not found' }) };
  }

  // Security: make sure this order belongs to the requesting user
  if ((order.customer_email || '').toLowerCase() !== userEmail) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'You do not have permission to cancel this order' }) };
  }

  // ── Check cancellability ─────────────────────────────────────────────────
  const status = String(order.status || '').toLowerCase();

  if (FINAL_STATUSES.includes(status)) {
    const msg = status === 'cancelled'
      ? 'This order is already cancelled.'
      : status === 'shipped' || status === 'out_for_delivery'
        ? 'This order has already been shipped and cannot be cancelled. Please use the return option after delivery.'
        : 'This order cannot be cancelled at this stage.';
    return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: msg }) };
  }

  if (!CANCELLABLE_STATUSES.includes(status)) {
    return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: 'Only COD orders that have not yet been dispatched can be cancelled.' }) };
  }

  // ── Cancel the order ─────────────────────────────────────────────────────
  const { error: updateErr } = await supabase
    .from('orders')
    .update({ status: 'cancelled' })
    .eq('id', order_id);

  if (updateErr) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: updateErr.message }) };
  }

  // ── Send cancellation email (non-fatal) ──────────────────────────────────
  if (order.customer_email) {
    await sendEmail({
      to: order.customer_email,
      subject: `Order cancelled — ${order.razorpay_order_id || order.id}`,
      html: cancellationEmailHtml(order),
    });
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ success: true, message: 'Order cancelled successfully.' }),
  };
};
