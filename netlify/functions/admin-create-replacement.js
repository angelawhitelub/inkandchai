/**
 * Netlify Function: admin-create-replacement
 * POST /.netlify/functions/admin-create-replacement
 *
 * Owner-initiated replacement shipment for a DELIVERED order — the counterpart
 * to the customer's own missing-book report (report-missing-books.js). Use when
 * a customer reports a missing or damaged book by phone/WhatsApp/email and there
 * is no self-service report to act on.
 *
 * Body:
 *   order_id     original order (razorpay_order_id or uuid)         REQUIRED
 *   items        [{ index, qty, price?, title? }]                   REQUIRED, >=1
 *                index = position in the ORIGINAL cart_items. price is rupees
 *                and overrides the original line price when supplied.
 *   amount_rs    what the courier collects, in rupees. 0 = free reshipment.
 *   reason       short slug, default 'missing_item'
 *   reason_label human-readable label shown in the admin Replacements tab
 *   note         internal note / what the customer said
 *   notify       email the customer (default true)
 *   force        allow a second replacement for the same original order
 *
 * Produces exactly the same row shape as the customer flow — status
 * replacement_pending, source 'replacement', _replacement meta on cart_items[0]
 * — so it lands in the unshipped list, the NimbusPost push and the Replacements
 * tab with no special-casing anywhere downstream.
 *
 * Amount is deliberately settable. A replacement is usually free (0), but a
 * partial reship the customer agreed to pay for is a real case, and since COD is
 * decided by captured money (see nimbuspost-order-push), an amount > 0 with no
 * payment id ships as COD and the courier collects exactly that.
 */

const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('./utils/email');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const clean = (v, max = 400) => String(v == null ? '' : v).trim().slice(0, max);

function replacementId(originalId) {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randPart = Array.from({ length: 5 }, () =>
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
  // Keep the CW marker so crossword-sourced replacements stay identifiable.
  return /^IC-CW-/i.test(String(originalId || '')) ? `IC-R-CW-${datePart}-${randPart}` : `IC-R-${datePart}-${randPart}`;
}

function replacementEmailHtml(order, items, replId, amountRs) {
  const first = String(order.customer_name || 'there').split(' ')[0];
  const rows = items.map(i => `
    <tr><td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#f0e8d8;">📕 ${i.title || 'Book'}${i.qty > 1 ? ` × ${i.qty}` : ''}</td></tr>`).join('');
  const payLine = amountRs > 0
    ? `<p style="color:#e8a030;margin:0;line-height:1.8;">Please keep <strong>₹${amountRs.toLocaleString('en-IN')}</strong> ready for the delivery agent.</p>`
    : `<p style="color:#6dbf6d;margin:0;line-height:1.8;">There is <strong>nothing to pay</strong> — this reshipment is free.</p>`;
  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:32px;">inkandchai.in</p>
      <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">We're sending your replacement 📦</h2>
      <p style="color:#a09080;line-height:1.8;margin:14px 0;">
        Hi ${first}, sorry about the trouble with order
        <strong style="color:#c9a84c;">${order.razorpay_order_id || order.id}</strong>.
        We've created a replacement shipment for:
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;"><tbody>${rows}</tbody></table>
      <div style="margin:18px 0;padding:16px;background:#152315;border-left:3px solid #6dbf6d;">
        <p style="color:#f0e8d8;margin:0 0 6px;font-size:15px;">Replacement order <strong style="color:#c9a84c;">${replId}</strong></p>
        ${payLine}
      </div>
      <p style="color:#a09080;font-size:13px;line-height:1.8;">We'll send tracking as soon as it's dispatched.</p>
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;"/>
      <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai · Reply to this email or message us on WhatsApp if anything else is wrong.</p>
    </div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const block = requireAdmin(event, CORS);
  if (block) return block;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Supabase is not configured' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const orderRef = clean(body.order_id, 120);
  if (!orderRef) return json(400, { error: 'Missing order_id' });
  if (!Array.isArray(body.items) || !body.items.length) {
    return json(400, { error: 'Select at least one book to replace' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    let { data: order } = await supabase.from('orders').select('*').eq('razorpay_order_id', orderRef).limit(1).maybeSingle();
    if (!order) {
      const alt = await supabase.from('orders').select('*').eq('id', orderRef).limit(1).maybeSingle();
      order = alt.data || null;
    }
    if (!order) return json(404, { error: 'Order not found' });
    if (String(order.source || '') === 'replacement') {
      return json(400, { error: 'This is already a replacement order — create the replacement against the original.' });
    }

    // Second replacement for the same original is possible (two separate
    // incidents) but is far more often a double-click or a duplicate report, so
    // it takes an explicit force.
    const { data: existing } = await supabase
      .from('orders')
      .select('razorpay_order_id, created_at')
      .eq('source', 'replacement')
      .eq('cart_items->0->_replacement->>original_order_id', String(order.razorpay_order_id || order.id))
      .limit(5);
    if (existing?.length && !body.force) {
      return json(409, {
        error: `This order already has a replacement (${existing.map(e => e.razorpay_order_id).join(', ')}). Re-submit with force to create another.`,
        existing: existing.map(e => e.razorpay_order_id),
        needs_force: true,
      });
    }

    const originalCart = Array.isArray(order.cart_items) ? order.cart_items : [];
    const cart = [];
    for (const sel of body.items) {
      const idx = Number(sel.index);
      const src = originalCart[idx];
      if (!src) return json(400, { error: `Item ${idx} is not in the original order` });
      const orderedQty = Math.max(1, Number(src.qty || src.quantity || 1));
      const qty = Math.min(orderedQty, Math.max(1, Number(sel.qty) || 1));
      // Strip the customer-report flags so the replacement cart is clean.
      const { _missing, _missing_at, _missing_qty, _replacement, ...rest } = src;
      cart.push({
        ...rest,
        qty,
        title: clean(sel.title || src.title || src.name || 'Book', 200),
        // A price override is for declaring value on the label; the collectable
        // is amount_rs. They are separate on purpose.
        ...(sel.price != null && sel.price !== '' ? { price: Math.max(0, Number(sel.price) || 0) } : {}),
      });
    }
    if (!cart.length) return json(400, { error: 'No valid books selected' });

    const amountRs = Math.max(0, Math.round((Number(body.amount_rs) || 0) * 100) / 100);
    const replId = replacementId(order.razorpay_order_id);
    cart[0]._replacement = {
      original_order_id: order.razorpay_order_id || order.id,
      reason: clean(body.reason, 40) || 'missing_item',
      reason_label: clean(body.reason_label, 120) || 'Item missing from package',
      note: clean(body.note, 1000) || 'Created manually by the store team.',
      created_by: 'admin',
      requested_at: new Date().toISOString(),
    };

    const { error: insErr } = await supabase.from('orders').insert({
      razorpay_order_id:   replId,
      razorpay_payment_id: null,
      amount_paise:        Math.round(amountRs * 100),
      status:              'replacement_pending',
      // Replacements are fulfilment shipments, never cash-on-delivery sales.
      // Persist this explicitly so generic order/admin status changes cannot
      // make NimbusPost collect from the customer again.
      shipment_payment_type: 'prepaid',
      customer_name:       order.customer_name || '',
      customer_email:      order.customer_email || '',
      customer_phone:      order.customer_phone || '',
      customer_address:    order.customer_address || '',
      cart_items:          cart,
      ...(order.user_id ? { user_id: order.user_id } : {}),
      source:              'replacement',
    });
    if (insErr) throw insErr;

    let emailed = false;
    if (body.notify !== false && order.customer_email) {
      try {
        await sendEmail({
          to: order.customer_email,
          subject: `📦 Replacement on the way for your Ink & Chai order (${replId})`,
          html: replacementEmailHtml(order, cart, replId, amountRs),
        });
        emailed = true;
      } catch (e) {
        // The replacement row is the thing that matters; a mail failure must not
        // lose it, or the owner would create a duplicate on retry.
        console.error('[admin-create-replacement] email failed:', e.message);
      }
    }

    return json(200, {
      success: true,
      replacement_id: replId,
      amount_rs: amountRs,
      items: cart.map(i => ({ title: i.title, qty: i.qty })),
      emailed,
      duplicate_of: existing?.length ? existing.map(e => e.razorpay_order_id) : undefined,
    });
  } catch (err) {
    console.error('admin-create-replacement error:', err);
    return json(500, { error: err.message });
  }
};
