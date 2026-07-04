/**
 * Netlify Function: request-return
 * POST /.netlify/functions/request-return
 *
 * Lets a signed-in customer initiate a return request from My Orders. The
 * return window is seven days from delivery date when available, otherwise
 * seven days from order creation.
 */

const { createClient } = require('@supabase/supabase-js');

const { sendEmail } = require('./utils/email');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clean(value, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function withinReturnWindow(order) {
  // Returns are ONLY allowed after the order has been delivered.
  // Using delivered_at exclusively — shipped_at / created_at are not valid
  // anchors because the customer hasn't received the book yet.
  if (!order.delivered_at) return false;
  const deliveredTime = new Date(order.delivered_at).getTime();
  if (!Number.isFinite(deliveredTime)) return false;
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  return Date.now() <= deliveredTime + sevenDays;
}


function ownerEmailHtml(order, reason) {
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const rows = items.map(i => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eadfca;">${esc(i.title)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eadfca;text-align:center;">${esc(i.qty)}</td>
    </tr>`).join('');
  return `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#2a2018;background:#faf7f2;padding:24px;">
      <h2 style="font-family:Georgia,serif;color:#8a6a1f;font-weight:400;">New return request</h2>
      <p><strong>Order:</strong> ${esc(order.razorpay_order_id || order.id)}</p>
      <p><strong>Customer:</strong> ${esc(order.customer_name)}<br>
      <strong>Email:</strong> ${esc(order.customer_email)}<br>
      <strong>Phone:</strong> ${esc(order.customer_phone)}</p>
      <p><strong>Reason:</strong><br>${esc(reason || 'Customer did not provide a reason.')}</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#fff;">
        <thead><tr><th style="padding:8px 10px;text-align:left;color:#8a6a1f;">Book</th><th style="padding:8px 10px;color:#8a6a1f;">Qty</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="font-size:13px;color:#5a4a38;"><strong>Address:</strong><br>${esc(order.customer_address)}</p>
    </div>`;
}

function customerEmailHtml(order) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#2a2018;background:#faf7f2;">
      <h2 style="font-family:Georgia,serif;font-weight:400;color:#8a6a1f;margin:0 0 12px;">Ink &amp; Chai</h2>
      <p>Hi ${esc((order.customer_name || 'there').split(' ')[0])},</p>
      <p>We received your return request for order <strong>${esc(order.razorpay_order_id || order.id)}</strong>.</p>
      <p>Our team will review it and contact you with the next steps. Please keep the book and packaging ready until we confirm pickup or return instructions.</p>
      <p style="font-size:12px;color:#8a7a62;margin-top:24px;">Ink &amp; Chai · inkandchai.in</p>
    </div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase is not configured.' }) };
    }

    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Please sign in first.' }) };

    const body = JSON.parse(event.body || '{}');
    const orderId = clean(body.order_id || body.id, 120);
    const reason = clean(body.reason, 1000);
    if (!orderId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing order id.' }) };

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: userResult, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userResult?.user?.email) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Please sign in again.' }) };
    }
    const email = userResult.user.email.toLowerCase();

    const { data: order, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .maybeSingle();
    if (error) throw error;
    if (!order || String(order.customer_email || '').toLowerCase() !== email) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Order not found for this account.' }) };
    }
    const orderStatus = String(order.status || '').toLowerCase();
    if (['cancelled', 'refunded'].includes(orderStatus)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'This order is not eligible for return.' }) };
    }
    // Must be delivered before a return can be raised
    if (orderStatus !== 'delivered') {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Returns can only be initiated after the order has been delivered. Please wait until delivery is confirmed.' }) };
    }
    if (!withinReturnWindow(order)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'The 7-day return window has expired for this order.' }) };
    }

    // Reject duplicate return requests for the same order
    const { data: existing } = await supabase
      .from('return_requests')
      .select('id, status')
      .eq('order_id', order.id)
      .maybeSingle();

    if (existing) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({
          error: 'A return request has already been submitted for this order. Our team will be in touch shortly. Please keep the package ready to hand over to the courier.',
          already_submitted: true,
        }),
      };
    }

    // Save return request to Supabase
    const { error: insertErr } = await supabase.from('return_requests').insert({
      order_id:         order.id,
      order_display_id: order.razorpay_order_id || order.id,
      customer_name:    order.customer_name    || '',
      customer_email:   order.customer_email   || '',
      customer_phone:   order.customer_phone   || '',
      customer_address: order.customer_address || '',
      items:            order.cart_items       || [],
      amount_paise:     order.amount_paise     || 0,
      reason:           reason,
      // Auto-approve: customer returns are accepted automatically (7-day window
      // + delivered guard already enforced above). Admin just pushes to
      // NimbusPost for pickup — no manual approval step.
      status:           'approved',
    });
    if (insertErr) throw insertErr;

    const ownerTo = process.env.STORE_OWNER_EMAIL || 'support@inkandchai.in';
    await sendEmail({
      to: ownerTo,
      subject: `Return request: ${order.razorpay_order_id || order.id}`,
      html: ownerEmailHtml(order, reason),
    });
    await sendEmail({
      to: order.customer_email,
      subject: `Return approved (${order.razorpay_order_id || order.id})`,
      html: customerEmailHtml(order),
    });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, message: 'Your return has been approved. Please keep the package ready — our courier will pick it up shortly.' }) };
  } catch (err) {
    console.error('request-return error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message || 'Could not submit return request.' }) };
  }
};
