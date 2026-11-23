/**
 * Netlify Function: admin-pay-later   (owner only — staff logins are refused,
 * because this endpoint has no staff permission in utils/admin-auth)
 *
 *   GET  ?action=config                  → { enabled, items }
 *   GET  ?slug=…                         → { slug, on }
 *   GET  ?action=orders&view=review|open|all → { orders: [...] }
 *   GET  ?action=kyc&order=IC-…          → { kyc, pan_image: { type, data } }  (full details)
 *   POST { action:'enabled', on }
 *   POST { action:'book', slug, on, title? }
 *   POST { action:'allow', phone, on, name?, note? } → customer may use Pay Later without 5 delivered orders
 *   POST { action:'approve', order }     → pay_later_review → confirmed, customer emailed
 *   POST { action:'reject', order, reason? } → cancelled, customer emailed
 *   POST { action:'send_link', order }   → (re)sends the payment link (delivered orders)
 *   POST { action:'mark_paid', order, note? } → paid another way (no gateway payment id)
 */
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const PL = require('./utils/pay-later');
const notify = require('./utils/pay-later-notify');
const { sendPayLaterLink, markPayLaterPaid } = require('./utils/pay-later-link');
const { r2GetObject, r2EbookConfig } = require('./utils/r2-put');
const { normSlug } = require('./utils/product-id');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const LIST_COLS = 'id, razorpay_order_id, razorpay_payment_id, status, amount_paise, customer_name, customer_phone, customer_email, customer_address, cart_items, created_at, tracking_id, courier_name';

async function loadOrder(supabase, id) {
  const oid = String(id || '').trim().toUpperCase();
  if (!/^IC-[A-Z0-9-]{5,40}$/.test(oid)) throw Object.assign(new Error('Unknown order id'), { status: 400 });
  const { data, error } = await supabase.from('orders').select('*').eq('razorpay_order_id', oid).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || !PL.isPayLater(data)) throw Object.assign(new Error('Not a Pay Later order'), { status: 404 });
  return data;
}

function summary(o) {
  const m = PL.payLaterMeta(o) || {};
  return {
    order_id: o.razorpay_order_id, status: o.status, amount: Math.round(Number(o.amount_paise) / 100),
    customer_name: o.customer_name, customer_phone: o.customer_phone, customer_email: o.customer_email,
    customer_address: o.customer_address, created_at: o.created_at, awb: o.tracking_id || '', courier: o.courier_name || '',
    paid: !PL.isUnpaidPayLater(o), payment_id: o.razorpay_payment_id || '',
    state: m.state || '', pan_name: m.pan_name || '', account_last4: m.account_last4 || '', delivered_orders: m.delivered_orders,
    due_at: m.due_at || null, link_url: m.link_url || '', link_sent_at: m.link_sent_at || null, paid_at: m.paid_at || null,
    reject_reason: m.reject_reason || '', allowed_by_owner: !!m.allowed_by_owner,
    books: PL.cartItems(o).filter((i) => i && (i.title || i.name)).map((i) => ({ title: i.title || i.name, qty: Number(i.qty) || 1, slug: i.slug || '' })),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  try {
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      if (q.slug) {
        const slug = normSlug(q.slug);
        const cfg = await PL.readConfig();
        return json(200, { slug, on: cfg.items.some((i) => i.slug === slug), enabled: cfg.enabled });
      }
      if (q.action === 'orders') {
        let query = supabase.from('orders').select(LIST_COLS)
          .eq('cart_items->0->_payment->>mode', 'pay_later')
          .order('created_at', { ascending: false }).limit(300);
        if (q.view === 'review') query = query.eq('status', PL.REVIEW_STATUS);
        const { data, error } = await query;
        if (error) throw new Error(error.message);
        let rows = (data || []).map(summary);
        if (q.view === 'open') rows = rows.filter((r) => r.status !== 'cancelled' && !r.paid);
        return json(200, { orders: rows });
      }
      if (q.action === 'kyc') {
        const order = await loadOrder(supabase, q.order);
        const prefix = (PL.payLaterMeta(order) || {}).kyc;
        if (!prefix) return json(404, { error: 'No KYC on this order' });
        const store = r2EbookConfig();
        const rec = await r2GetObject(store, `${prefix}kyc.json`);
        if (!rec.ok) return json(502, { error: `KYC record unreadable (R2 ${rec.status})` });
        const kyc = JSON.parse(Buffer.from(rec.body).toString('utf8'));
        const img = kyc.pan_image ? await r2GetObject(store, kyc.pan_image) : { ok: false };
        console.log(`[admin-pay-later] KYC viewed for ${order.razorpay_order_id}`);
        return json(200, {
          kyc,
          pan_image: img.ok ? { type: img.contentType, data: Buffer.from(img.body).toString('base64') } : null,
        });
      }
      const cfg = await PL.readConfig();
      return json(200, { enabled: cfg.enabled, items: cfg.items, allow: cfg.allow, updated_at: cfg.updated_at, min_orders: PL.MIN_DELIVERED, due_days: PL.DUE_DAYS });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

    switch (body.action) {
      case 'enabled': {
        const doc = await PL.setEnabled(body.on === true);
        console.log(`[admin-pay-later] Pay Later ${doc.enabled ? 'ON' : 'OFF'}`);
        return json(200, { enabled: doc.enabled, items: doc.items });
      }
      case 'book': {
        const slug = normSlug(body.slug);
        if (!slug) return json(400, { error: 'Missing product slug' });
        const doc = await PL.setBook(slug, body.on === true, { title: body.title });
        return json(200, { slug, on: doc.items.some((i) => i.slug === slug), enabled: doc.enabled });
      }
      case 'allow': {
        const doc = await PL.setAllowed(body.phone, body.on === true, { name: body.name, note: body.note });
        const ten = PL.phone10(body.phone);
        console.log(`[admin-pay-later] allow-list ${body.on === true ? 'added' : 'removed'} …${ten.slice(-4)}`);
        return json(200, { phone: ten, on: doc.allow.some((a) => a.phone === ten), allow: doc.allow });
      }
      case 'approve': {
        const order = await loadOrder(supabase, body.order);
        if (order.status !== PL.REVIEW_STATUS) return json(409, { error: `Order is ${order.status}, not waiting for review.` });
        const cart = PL.withMeta(order, (m) => ({ ...m, state: 'approved', approved_at: new Date().toISOString() }));
        const { data, error } = await supabase.from('orders').update({ status: 'confirmed', cart_items: cart })
          .eq('id', order.id).eq('status', PL.REVIEW_STATUS).select('id');
        if (error) throw new Error(error.message);
        if (!data || !data.length) return json(409, { error: 'Someone else changed this order first. Refresh.' });
        const mail = await notify.approved({ ...order, status: 'confirmed', cart_items: cart });
        return json(200, { ok: true, status: 'confirmed', emailed: !!mail.sent });
      }
      case 'reject': {
        const order = await loadOrder(supabase, body.order);
        if (order.status !== PL.REVIEW_STATUS) return json(409, { error: `Order is ${order.status}, not waiting for review.` });
        const reason = String(body.reason || '').trim().slice(0, 300);
        const cart = PL.withMeta(order, (m) => ({ ...m, state: 'rejected', rejected_at: new Date().toISOString(), ...(reason ? { reject_reason: reason } : {}) }));
        const { data, error } = await supabase.from('orders').update({ status: 'cancelled', cart_items: cart })
          .eq('id', order.id).eq('status', PL.REVIEW_STATUS).select('id');
        if (error) throw new Error(error.message);
        if (!data || !data.length) return json(409, { error: 'Someone else changed this order first. Refresh.' });
        const mail = await notify.rejected({ ...order, cart_items: cart }, reason);
        return json(200, { ok: true, status: 'cancelled', emailed: !!mail.sent });
      }
      case 'send_link': {
        const order = await loadOrder(supabase, body.order);
        if (order.status !== 'delivered') return json(409, { error: `The link goes out once the order is delivered (it is ${order.status}).` });
        const r = await sendPayLaterLink(supabase, order);
        return json(r.ok ? 200 : 409, r);
      }
      case 'mark_paid': {
        const order = await loadOrder(supabase, body.order);
        const r = await markPayLaterPaid(supabase, order, { how: 'manual', note: body.note });
        return json(200, r);
      }
      default:
        return json(400, { error: 'Unknown action' });
    }
  } catch (e) {
    console.error('[admin-pay-later]', e.message);
    return json(e.status || 500, { error: e.message });
  }
};

