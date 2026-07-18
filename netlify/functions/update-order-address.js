/**
 * Netlify Function: update-order-address
 * POST /.netlify/functions/update-order-address   { id, q, address }
 *
 * PUBLIC (customer-facing) endpoint — lets a customer correct their delivery
 * address ONCE, and only before the order is handed to a courier (no AWB /
 * tracking assigned and status not shipped/in-transit/delivered/terminal).
 *
 * Ownership is verified the SAME way as track-order / report-missing-books
 * (order id + the email/phone used at checkout must match). On success it
 * updates customer_address, stamps address_updated_by_customer_at (which locks
 * further edits), and alerts the store OWNER so the parcel ships to the new
 * address.
 *
 * Requires: sql — alter table orders add column address_updated_by_customer_at.
 */

const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('./utils/email');
const { sendText } = require('./utils/whatsapp');
const { canEditAddress, addressLockReason } = require('./utils/address-editable');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const orderId = (o) => o.razorpay_order_id || o.id;
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase env vars missing' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const id = String(body.id || '').trim().replace(/\s+/g, '');
  const q  = String(body.q  || '').trim();
  const address = String(body.address || '').trim().replace(/\s+\n/g, '\n').slice(0, 1000);
  if (!id || !q)             return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide order id and email/phone' }) };
  if (address.length < 12)   return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Please enter a complete delivery address (with area, city and pincode).' }) };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Locate the order (exact then case-insensitive, like track-order).
    let { data: order } = await supabase.from('orders').select('*').eq('razorpay_order_id', id).limit(1).maybeSingle();
    if (!order) {
      const r2 = await supabase.from('orders').select('*').ilike('razorpay_order_id', id).limit(1).maybeSingle();
      order = r2.data || null;
    }
    if (!order) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Order not found. Check the order ID and try again.' }) };

    // Ownership — email OR last-10 of phone must match.
    const qn = norm(q);
    const qDigits = qn.replace(/\D/g, '');
    const emailOk = order.customer_email && norm(order.customer_email) === qn;
    const phoneOk = order.customer_phone && qDigits.length >= 10 && norm(order.customer_phone).replace(/\D/g, '').slice(-10) === qDigits.slice(-10);
    if (!emailOk && !phoneOk) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Email or phone does not match this order.' }) };
    }

    // Eligibility — one-time, pre-handoff only.
    if (!canEditAddress(order)) {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: addressLockReason(order), can_edit_address: false }) };
    }

    const oldAddress = order.customer_address || '';
    if (norm(address) === norm(oldAddress)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'The address is unchanged.' }) };
    }

    // Atomic one-time claim: only update if it hasn't already been changed —
    // guards against a double-submit slipping two edits through.
    const claim = await supabase
      .from('orders')
      .update({ customer_address: address, address_updated_by_customer_at: new Date().toISOString() })
      .eq('id', order.id)
      .is('address_updated_by_customer_at', null)
      .select('id');
    if (claim.error || !claim.data || !claim.data.length) {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: addressLockReason({ ...order, address_updated_by_customer_at: new Date().toISOString() }), can_edit_address: false }) };
    }

    // ── Alert the owner so the parcel ships to the NEW address ────────────────
    const ownerEmail = process.env.STORE_OWNER_EMAIL;
    if (ownerEmail) {
      sendEmail({
        to: ownerEmail,
        subject: `📍 Address changed by customer — order ${orderId(order)} (not yet shipped)`,
        html: `
          <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
            <h1 style="color:#c9a84c;font-size:22px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
            <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:24px;">Admin notification</p>
            <h2 style="color:#e0a94a;font-size:20px;font-weight:400;">Customer updated their delivery address</h2>
            <p style="color:#a09080;font-size:13px;">Order <strong style="color:#c9a84c;">${orderId(order)}</strong> &middot; status: ${order.status || '—'} &middot; not yet shipped.</p>
            <p style="color:#a09080;margin:14px 0 4px;">Name: <strong style="color:#f0e8d8;">${order.customer_name || '—'}</strong> &middot; ${order.customer_phone || '—'}</p>
            <div style="margin:16px 0;padding:14px;background:#231a12;border-left:3px solid #a0785a;">
              <p style="color:#a09080;font-size:12px;margin:0 0 4px;text-transform:uppercase;letter-spacing:1px;">Old address</p>
              <p style="color:#c9b7a4;margin:0;line-height:1.7;">${(oldAddress || '—').replace(/</g,'&lt;')}</p>
            </div>
            <div style="margin:16px 0;padding:14px;background:#152315;border-left:3px solid #6dbf6d;">
              <p style="color:#a09080;font-size:12px;margin:0 0 4px;text-transform:uppercase;letter-spacing:1px;">New address — ship here</p>
              <p style="color:#f0e8d8;margin:0;line-height:1.7;">${address.replace(/</g,'&lt;')}</p>
            </div>
            <p style="color:#a09080;font-size:12px;">The order row already shows the new address. This is a one-time change — the customer can't edit it again.</p>
          </div>`,
      }).catch(e => console.error('[update-order-address] owner email:', e.message));
    }
    if (process.env.STORE_OWNER_PHONE) {
      sendText(
        process.env.STORE_OWNER_PHONE,
        `📍 Address changed for order ${orderId(order)} (not yet shipped).\n\n` +
        `${order.customer_name || ''} ${order.customer_phone || ''}\n\n` +
        `NEW address — ship here:\n${address}\n\n(One-time change; order row is already updated.)`
      ).catch(() => {});
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, address, can_edit_address: false }),
    };
  } catch (err) {
    console.error('update-order-address error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
