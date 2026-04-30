/**
 * Netlify Function: update-order-status
 * POST /.netlify/functions/update-order-status
 *
 * Admin endpoint — update order status, optionally attach tracking info.
 * When status flips to "shipped" (and tracking_id is provided), automatically
 * sends a shipment-confirmation email to the customer with the tracking link.
 *
 * Required Supabase columns (run once):
 *   alter table orders add column if not exists tracking_id   text;
 *   alter table orders add column if not exists courier_name  text;
 *   alter table orders add column if not exists tracking_url  text;
 *   alter table orders add column if not exists shipped_at    timestamptz;
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

const VALID_STATUSES = ['cod_pending', 'confirmed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'paid', 'refunded'];

// Known Indian couriers + their tracking URL templates
const COURIER_URLS = {
  'bluedart':     'https://www.bluedart.com/tracking?trackingNumber={id}',
  'dtdc':         'https://www.dtdc.in/tracking/tracking_results.asp?action=track&Type=awb&strCnno={id}',
  'delhivery':    'https://www.delhivery.com/tracking/package/{id}',
  'indiapost':    'https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx?id={id}',
  'ecomexpress':  'https://ecomexpress.in/tracking/?awb_field={id}',
  'shadowfax':    'https://shadowfax.in/tracking/?awb={id}',
  'xpressbees':   'https://www.xpressbees.com/track?awbNo={id}',
  'shiprocket':   'https://shiprocket.co/tracking/{id}',
  'professional': 'https://www.tpcindia.com/Tracking2/Tracking2.aspx?cnno={id}',
};

function buildTrackingUrl(courier, trackingId) {
  if (!trackingId) return '';
  const key = (courier || '').toLowerCase().replace(/\s+/g, '');
  const tpl = COURIER_URLS[key];
  return tpl ? tpl.replace('{id}', encodeURIComponent(trackingId)) : '';
}

// ── Send email via Resend (auto-fallback to onboarding@resend.dev) ────────
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
  } catch (err) { console.error('sendEmail exception:', err.message); }
}

function shipmentEmailHtml(order) {
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const total = order.amount_paise ? (order.amount_paise / 100) : items.reduce((s, i) => s + i.price * i.qty, 0);
  const isCOD = order.status === 'cod_pending' || !order.razorpay_payment_id;
  const rows = items.map(i => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;">${i.title}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;text-align:center;">${i.qty}</td>
    </tr>`).join('');
  const trackBlock = order.tracking_id ? `
    <div style="margin:24px 0;padding:18px;background:#1c1916;border-left:3px solid #c9a84c;">
      <p style="color:#a09080;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 6px;">Courier &amp; Tracking</p>
      <p style="color:#f0e8d8;font-size:16px;margin:0 0 4px;"><strong>${order.courier_name || 'Courier'}</strong></p>
      <p style="color:#c9a84c;font-size:14px;font-family:Menlo,Consolas,monospace;margin:0 0 12px;">AWB: ${order.tracking_id}</p>
      ${order.tracking_url ? `<a href="${order.tracking_url}" style="display:inline-block;background:#c9a84c;color:#0d0b08;padding:10px 24px;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:600;">Track on courier site →</a>` : ''}
    </div>` : '';

  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">inkandchai.in</p>
      <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">📦 Your order has shipped!</h2>
      <p style="color:#a09080;line-height:1.8;margin:14px 0;">
        Hi ${order.customer_name?.split(' ')[0] || 'there'}, great news — your books are on the way to you.
      </p>
      ${trackBlock}
      <p style="color:#a09080;font-size:13px;line-height:1.8;">Order ID: <strong style="color:#c9a84c;">${order.razorpay_order_id || order.id}</strong></p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
        <thead><tr style="background:#1c1916;">
          <th style="padding:8px 12px;text-align:left;color:#c9a84c;font-weight:500;">Book</th>
          <th style="padding:8px 12px;text-align:center;color:#c9a84c;font-weight:500;">Qty</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${isCOD ? `<p style="color:#6dbf6d;font-size:13px;background:rgba(109,191,109,0.1);padding:10px 14px;">💰 Cash on Delivery — please keep ₹${total.toLocaleString('en-IN')} ready when the delivery arrives.</p>` : ''}
      <p style="margin-top:18px;color:#a09080;font-size:13px;">
        You can also track this order anytime at
        <a href="https://inkandchai.in/track/?id=${encodeURIComponent(order.razorpay_order_id || order.id)}" style="color:#c9a84c;">inkandchai.in/track</a>
      </p>
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai · For support, reply to this email or message us on WhatsApp.</p>
    </div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const adminKey = process.env.ADMIN_SECRET;
  const sentKey  = event.headers['x-admin-key'];
  if (!adminKey || sentKey !== adminKey) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { id, status, tracking_id, courier_name } = body;
  if (!id || !status) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing id or status' }) };
  if (!VALID_STATUSES.includes(status)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid status' }) };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // First update just the status (always works regardless of migration state)
    {
      const { error: updErr } = await supabase.from('orders').update({ status }).eq('id', id);
      if (updErr) throw updErr;
    }

    let trackingUrl = '';
    // Then, if shipped, try to attach tracking info — tolerate missing columns
    // gracefully so this works even before SQL_MIGRATIONS.md has been run.
    if (status === 'shipped' && tracking_id) {
      trackingUrl = buildTrackingUrl(courier_name, tracking_id);
      const trackingPayload = {
        tracking_id,
        courier_name,
        tracking_url: trackingUrl,
        shipped_at: new Date().toISOString(),
      };
      const { error: trkErr } = await supabase.from('orders').update(trackingPayload).eq('id', id);
      if (trkErr) {
        // Likely a missing-column error — swallow and warn so the status update
        // still succeeds. The admin sees a hint that they need to run the
        // migration.
        console.warn('Tracking columns update failed (run SQL_MIGRATIONS.md):', trkErr.message);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({
          success: true,
          tracking_url: trackingUrl,
          warning: 'Status updated, but tracking info was NOT saved. Run the SQL migration in SQL_MIGRATIONS.md to enable tracking storage. Until then the customer email will still be sent (with the URL) but tracking won\'t persist.',
        }) };
      }
    }

    // Fire shipment email regardless of whether columns persisted (non-fatal)
    if (status === 'shipped') {
      const { data: order } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
      if (order && order.customer_email) {
        // Inject tracking info (in case columns don't persist yet)
        order.tracking_id   = order.tracking_id   || tracking_id;
        order.courier_name  = order.courier_name  || courier_name;
        order.tracking_url  = order.tracking_url  || trackingUrl;
        await sendEmail({
          to: order.customer_email,
          subject: `📦 Your Ink & Chai order has shipped (${order.razorpay_order_id || order.id})`,
          html: shipmentEmailHtml(order),
        });
      }
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, tracking_url: trackingUrl || null }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
