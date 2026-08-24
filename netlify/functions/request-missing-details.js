/**
 * Netlify Function: request-missing-details
 * POST { dry_run?: true, order_ids?: ["IC-…"], channels?: ["whatsapp","email"] }
 * Header: X-Admin-Key
 *
 * Asks the customers whose order details were lost on 24 Aug for the two things
 * we cannot recover any other way: their delivery address and what they
 * ordered. Their replies are handled by the WhatsApp bot, which verifies the
 * books against what they paid and writes them straight back onto the order —
 * see utils/order-detail-recovery.js.
 *
 * WhatsApp free-form messages only reach someone who has messaged the business
 * in the last 24 hours. Outside that window Meta rejects the send, and this
 * reports it per customer rather than pretending it went out; email always
 * goes, so nobody is left uncontacted.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { findAwaitingOrders } = require('./utils/order-detail-recovery');
const { sendText } = require('./utils/whatsapp');
const { sendEmail } = require('./utils/email');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, obj) => ({ statusCode, headers: CORS, body: JSON.stringify(obj) });

const firstName = (n) => String(n || 'there').trim().split(/\s+/)[0];
const rupees = (paise) => `₹${((paise || 0) / 100).toLocaleString('en-IN')}`;

function waText(order) {
  const partial = order.status === 'partial_cod_pending';
  return `Hi ${firstName(order.customer_name)}, this is Ink & Chai 📚

About your order ${order.razorpay_order_id} — your payment of ${rupees(order.amount_paise)}${partial ? ' (10% advance for Cash on Delivery)' : ''} is confirmed and safe.

A technical fault at our end on 24 August lost two details from this order. Could you please reply with:
1. Your complete delivery address, including the 6-digit pincode
2. The name(s) of the book(s) you ordered

Send both in one reply and we'll dispatch it right away. Sorry for the trouble.`;
}

function emailHtml(order) {
  const partial = order.status === 'partial_cod_pending';
  return `<div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
    <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
    <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">inkandchai.in</p>
    <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">We need two details to send your books</h2>
    <p style="color:#a09080;line-height:1.8;">
      Hi ${firstName(order.customer_name)}, your payment of
      <strong style="color:#c9a84c;">${rupees(order.amount_paise)}</strong>${partial ? ' (the 10% advance on your Cash on Delivery order)' : ''}
      for order <strong style="color:#c9a84c;">${order.razorpay_order_id}</strong> is confirmed and safe.
    </p>
    <p style="color:#a09080;line-height:1.8;">
      A technical fault at our end on 24 August lost two details from this order. Could you reply to this email — or on WhatsApp at +91 92171 75562 — with:
    </p>
    <ol style="color:#f0e8d8;line-height:2;">
      <li>Your complete delivery address, including the 6-digit pincode</li>
      <li>The name(s) of the book(s) you ordered</li>
    </ol>
    <p style="color:#a09080;line-height:1.8;">We'll dispatch it as soon as we hear back. Apologies for the inconvenience.</p>
    <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
    <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai · inkandchai.in</p>
  </div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  const dryRun = !!body.dry_run;
  const channels = Array.isArray(body.channels) && body.channels.length
    ? body.channels.map(c => String(c).toLowerCase())
    : ['whatsapp', 'email'];

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY are required.' });
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let orders;
  try { orders = await findAwaitingOrders(supabase, { limit: 100 }); }
  catch (err) { return json(500, { error: err.message }); }

  if (Array.isArray(body.order_ids) && body.order_ids.length) {
    const want = new Set(body.order_ids.map(id => String(id).toUpperCase()));
    orders = orders.filter(o => want.has(String(o.razorpay_order_id).toUpperCase()));
  }

  const results = [];
  for (const order of orders) {
    const r = {
      order_id: order.razorpay_order_id,
      customer: order.customer_name,
      amount: rupees(order.amount_paise),
      whatsapp: 'skipped',
      email: 'skipped',
    };

    if (dryRun) {
      r.whatsapp = order.customer_phone ? 'would send' : 'no phone on order';
      r.email = order.customer_email ? 'would send' : 'no email on order';
      results.push(r);
      continue;
    }

    if (channels.includes('whatsapp') && order.customer_phone) {
      try {
        await sendText(order.customer_phone, waText(order));
        r.whatsapp = 'sent';
      } catch (err) {
        // Almost always "outside the 24-hour window" — a template is needed for
        // those, so the failure is reported, not swallowed.
        r.whatsapp = `failed: ${String(err.message).slice(0, 160)}`;
      }
    } else if (channels.includes('whatsapp')) {
      r.whatsapp = 'no phone on order';
    }

    if (channels.includes('email') && order.customer_email) {
      try {
        await sendEmail({
          to: order.customer_email,
          subject: `Action needed: two details for your Ink & Chai order ${order.razorpay_order_id}`,
          html: emailHtml(order),
        });
        r.email = 'sent';
      } catch (err) {
        r.email = `failed: ${String(err.message).slice(0, 160)}`;
      }
    } else if (channels.includes('email')) {
      r.email = 'no email on order';
    }

    results.push(r);
  }

  const reached = results.filter(r => r.whatsapp === 'sent' || r.email === 'sent').length;
  return json(200, {
    success: true,
    dry_run: dryRun,
    awaiting_details: orders.length,
    reached,
    results,
  });
};
