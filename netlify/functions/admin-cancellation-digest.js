/**
 * Netlify Function: admin-cancellation-digest
 * POST /.netlify/functions/admin-cancellation-digest  { order_ids: [...] }
 *
 * ONE owner email summarising a batch of cancellations, in place of one email
 * per order.
 *
 * Why this exists: the admin panel cancels one order per request on purpose --
 * each cancellation calls a payment gateway and sends the customer two
 * messages, so batching them into a single request would blow the function
 * timeout and leave us unsure which ones actually went through. The cost was
 * one owner email per order, and closing the 106-order NimbusPost backlog put
 * 106 near-identical "Order Cancelled" mails in the inbox at once. The caller
 * passes skip_owner_email on each cancel and then calls this once.
 *
 * Only the OWNER copy is merged. Customers still get their own email and
 * WhatsApp per order -- those are not ours to batch.
 *
 * The client sends order ids and nothing else: the rows are re-read here and
 * only genuinely cancelled ones are reported, so the summary cannot be shaped
 * by whatever the browser felt like posting.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { sendEmail } = require('./utils/email');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

const money = (paise) => '₹' + (Number(paise || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });

function esc(v) {
  return String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function paidVia(o) {
  if (!o.razorpay_payment_id) return 'COD';
  return String(o.razorpay_payment_id).startsWith('pay_') ? 'Razorpay' : 'PhonePe';
}

// What the customer is actually owed. Mirrors the NP-cancelled sweep: a free
// replacement has no customer money in it however it was paid for.
function refundDuePaise(o) {
  const isReplacement = String(o.source || '').toLowerCase() === 'replacement'
    || /^IC-R-/i.test(String(o.razorpay_order_id || ''));
  if (isReplacement) return 0;
  if (o.razorpay_payment_id) return Number(o.amount_paise || 0);
  return Number(o.advance_paid_paise || 0);
}

function digestHtml(orders, reason) {
  const totalValue = orders.reduce((s, o) => s + Number(o.amount_paise || 0), 0);
  const totalRefund = orders.reduce((s, o) => s + refundDuePaise(o), 0);
  const prepaid = orders.filter(o => !!o.razorpay_payment_id).length;

  const rows = orders.map(o => {
    const due = refundDuePaise(o);
    return `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #2a2a2a;color:#c9a84c;font-family:monospace;font-size:12px;">${esc(o.razorpay_order_id)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #2a2a2a;font-size:13px;">${esc(o.customer_name || '—')}<div style="color:#a09080;font-size:11px;">${esc(o.customer_phone || '')}</div></td>
      <td style="padding:8px 10px;border-bottom:1px solid #2a2a2a;font-size:13px;text-align:right;">${money(o.amount_paise)}<div style="color:#a09080;font-size:11px;">${esc(paidVia(o))}</div></td>
      <td style="padding:8px 10px;border-bottom:1px solid #2a2a2a;font-size:13px;text-align:right;color:${due > 0 ? '#e87070' : '#6dbf6d'};">${due > 0 ? money(due) : '—'}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #2a2a2a;font-size:11px;color:#a09080;">${esc(o.refund_state || o.status || '')}</td>
    </tr>`;
  }).join('');

  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:720px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:24px;">Admin notification</p>
      <h2 style="color:#e87070;font-size:20px;font-weight:400;margin-bottom:4px;">${orders.length} Orders Cancelled</h2>
      <p style="color:#a09080;font-size:13px;margin-top:0;">${esc(reason || 'Cancelled from the admin panel.')}</p>

      <div style="background:#1c1916;border-left:3px solid #e87070;padding:14px 18px;margin:18px 0;font-size:14px;">
        <div style="color:#a09080;font-size:12px;">Order value</div>
        <div style="color:#f0e8d8;font-size:18px;margin-bottom:10px;">${money(totalValue)}</div>
        <div style="color:#a09080;font-size:12px;">Refund due to customers</div>
        <div style="color:#e87070;font-size:18px;">${money(totalRefund)}<span style="color:#a09080;font-size:12px;"> across ${prepaid} prepaid order(s)</span></div>
      </div>

      <table style="width:100%;border-collapse:collapse;font-family:Georgia,serif;">
        <thead>
          <tr style="color:#a09080;font-size:11px;letter-spacing:1px;text-transform:uppercase;">
            <th style="text-align:left;padding:6px 10px;">Order</th>
            <th style="text-align:left;padding:6px 10px;">Customer</th>
            <th style="text-align:right;padding:6px 10px;">Amount</th>
            <th style="text-align:right;padding:6px 10px;">Refund due</th>
            <th style="text-align:left;padding:6px 10px;">State</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      <p style="color:#a09080;font-size:12px;margin-top:22px;line-height:1.7;">
        Each customer was emailed and WhatsApped separately. Prepaid refunds are issued
        automatically; PhonePe settles over a few hours and the hourly reconcile marks
        them refunded once the gateway confirms.
      </p>
    </div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const denied = requireAdmin(event, CORS);
  if (denied) return denied;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const ids = (Array.isArray(body.order_ids) ? body.order_ids : [])
    .map(v => String(v || '').trim()).filter(Boolean).slice(0, 500);
  if (!ids.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide order_ids[]' }) };
  }

  const ownerEmail = process.env.STORE_OWNER_EMAIL;
  if (!ownerEmail) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, skipped: 'STORE_OWNER_EMAIL not set' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data, error } = await supabase
    .from('orders')
    .select('razorpay_order_id,razorpay_payment_id,status,amount_paise,advance_paid_paise,customer_name,customer_phone,refund_state,source')
    .in('razorpay_order_id', ids);
  if (error) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
  }

  // Report only what is actually cancelled, so a stale or wrong id in the
  // request cannot put a live order into a "cancelled" summary.
  const orders = (data || []).filter(o => String(o.status || '').toLowerCase() === 'cancelled');
  if (!orders.length) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, sent: false, reason: 'no cancelled orders matched' }) };
  }

  const sent = await sendEmail({
    to: ownerEmail,
    subject: `❌ ${orders.length} Orders Cancelled — ${money(orders.reduce((s, o) => s + Number(o.amount_paise || 0), 0))}`,
    html: digestHtml(orders, body.reason),
  });

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ ok: true, sent: !!sent?.ok, orders: orders.length, requested: ids.length }),
  };
};
