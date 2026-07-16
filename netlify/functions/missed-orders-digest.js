/**
 * Netlify Function: missed-orders-digest
 * POST /.netlify/functions/missed-orders-digest   { hours?: number, since?: ISO }
 *
 * Admin recovery tool — when owner order-alert emails failed to deliver (e.g. an
 * email provider silently accepted-then-dropped them), this re-sends ONE digest
 * listing every order placed in the window, instead of blasting one email per
 * order (which would burn quota and flood the inbox).
 *
 * Sends to STORE_OWNER_EMAIL. Read-only against orders — it never mutates them.
 * Headers: X-Admin-Token / X-Admin-Key.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { sendEmail } = require('./utils/email');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Admin-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const PAY_LABEL = {
  cod_pending: 'COD', partial_cod_pending: 'Partial COD',
  paid: 'Prepaid', confirmed: 'Confirmed',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase env vars missing' }) };
  }
  const to = process.env.STORE_OWNER_EMAIL;
  if (!to) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'STORE_OWNER_EMAIL is not set' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* defaults */ }

  const hours = Math.min(168, Math.max(1, Number(body.hours) || 12));   // cap at 7 days
  const since = body.since ? new Date(body.since) : new Date(Date.now() - hours * 3600 * 1000);
  if (isNaN(since.getTime())) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid "since" timestamp' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: orders, error } = await supabase
      .from('orders')
      .select('razorpay_order_id, id, created_at, customer_name, customer_phone, customer_email, customer_address, amount_paise, cart_items, status')
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: true })
      .limit(500);
    if (error) throw error;

    const rows = orders || [];
    if (!rows.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, count: 0, message: `No orders since ${since.toLocaleString('en-IN')}.` }) };
    }

    let total = 0;
    const trs = rows.map(o => {
      const rs = Math.round((o.amount_paise || 0) / 100);
      total += rs;
      const items = Array.isArray(o.cart_items)
        ? o.cart_items.map(i => `${esc(i.title || i.name || 'Book')}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join('<br>')
        : '—';
      const when = o.created_at
        ? new Date(o.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
        : '—';
      return `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid #eadfca;font-size:12px;white-space:nowrap;">${when}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eadfca;font-size:12px;color:#8a6a1f;">${esc(o.razorpay_order_id || o.id)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eadfca;font-size:12px;">${esc(o.customer_name)}<br><span style="color:#7a6a58;">${esc(o.customer_phone)}</span></td>
        <td style="padding:8px 10px;border-bottom:1px solid #eadfca;font-size:12px;">${items}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eadfca;font-size:12px;text-align:right;white-space:nowrap;">₹${rs.toLocaleString('en-IN')}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eadfca;font-size:11px;">${esc(PAY_LABEL[o.status] || o.status || '—')}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eadfca;font-size:11px;color:#5a4a38;">${esc(String(o.customer_address || '').slice(0, 90))}</td>
      </tr>`;
    }).join('');

    const result = await sendEmail({
      to,
      subject: `📋 Missed order digest — ${rows.length} order${rows.length > 1 ? 's' : ''} · ₹${total.toLocaleString('en-IN')} (since ${since.toLocaleString('en-IN')})`,
      html: `<div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto;background:#faf7f2;padding:24px;color:#2a2018;">
        <h2 style="font-family:Georgia,serif;color:#8a6a1f;font-weight:400;margin:0 0 4px;">Missed order digest</h2>
        <p style="margin:0 0 16px;font-size:13px;color:#5a4a38;">
          Every order placed since <strong>${esc(since.toLocaleString('en-IN'))}</strong> — re-sent because the original
          per-order alerts failed to deliver. <strong>${rows.length} order${rows.length > 1 ? 's' : ''}</strong>,
          total <strong>₹${total.toLocaleString('en-IN')}</strong>.
        </p>
        <table style="width:100%;border-collapse:collapse;background:#fff;">
          <thead><tr style="background:#f4ecd9;">
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:#8a6a1f;">When</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:#8a6a1f;">Order</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:#8a6a1f;">Customer</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:#8a6a1f;">Items</th>
            <th style="padding:8px 10px;text-align:right;font-size:11px;color:#8a6a1f;">Amount</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:#8a6a1f;">Type</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:#8a6a1f;">Address</th>
          </tr></thead>
          <tbody>${trs}</tbody>
        </table>
        <p style="font-size:11px;color:#8a7a62;margin-top:16px;">Ink &amp; Chai · admin recovery digest</p>
      </div>`,
    });

    return {
      statusCode: result.ok ? 200 : 502,
      headers: CORS,
      body: JSON.stringify({
        success: !!result.ok,
        count: rows.length,
        total_rupees: total,
        since: since.toISOString(),
        delivered_via: result.provider || null,
        error: result.error || null,
      }),
    };
  } catch (err) {
    console.error('missed-orders-digest error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
