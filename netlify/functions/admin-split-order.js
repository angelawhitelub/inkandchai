/**
 * POST /.netlify/functions/admin-split-order   (admin)
 *
 * Split one order into several shipments: ship the books that are in stock
 * now, send the rest later. Owner request, 9 Nov 2026.
 *
 * Body:
 *   order_id   the original order (razorpay_order_id or uuid)          REQUIRED
 *   shipments  [[{ index, qty }, ...], ...]  one array per NEW shipment;
 *              index = position in the order's current cart_items.    REQUIRED
 *   notify     tell the customer by email + WhatsApp (default true)
 *   dry_run    DEFAULTS TO TRUE: only a real run needs dry_run:false. The
 *              preview runs every check and the XpressBees serviceability
 *              lookup (read-only) and writes nothing.
 *
 * What it does (see utils/order-split.js for the money rule):
 *   - the original keeps its id, its payment and the books that stay;
 *   - each new shipment is an order <parent>-S2, -S3 ... (<= 20 characters, the
 *     XpressBees order-number limit), status 'confirmed', source 'split',
 *     amount 0, prepaid: it lands in the unshipped list like any order;
 *   - counted stock moves with the books, so the stock trigger neither takes
 *     the moved books a second time nor gives them back twice on a cancel;
 *   - when the original ALREADY HAS AN AWB, the new shipment is routed now:
 *     XpressBees serves the pincode -> it waits in the XpressBees queue (the
 *     channel feed, as every unshipped order does); XpressBees does not ->
 *     pushed to the NimbusPost panel. Unknown -> left for the owner, said so.
 *     An unshipped original's split shipments flow like any unshipped order.
 */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { sendEmail } = require('./utils/email');
const { classifyShipmentMoney } = require('./utils/shipment-money');
const split = require('./utils/order-split');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const DOUBLE_SUBMIT_MS = 2 * 60 * 1000;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const titleOf = (i) => String((i && (i.title || i.name)) || 'Book').trim();
const linesText = (cart) => cart.map((i) => `${titleOf(i)}${split.qtyOf(i) > 1 ? ` ×${split.qtyOf(i)}` : ''}`).join(', ');

/** What the customer still pays at the door on the original parcel, in rupees. */
function collectOnParent(order) {
  try { return classifyShipmentMoney(order, false).collectableAmount || 0; } catch { return 0; }
}

function emailHtml(order, parentCart, children, collect) {
  const first = esc(String(order.customer_name || 'there').split(' ')[0]);
  const pid = esc(order.razorpay_order_id || order.id);
  const box = (label, cart, note) => `
    <div style="margin:14px 0;padding:14px 16px;background:#17130d;border-left:3px solid #c9a84c;">
      <p style="color:#c9a84c;margin:0 0 8px;font-size:14px;"><strong>${esc(label)}</strong></p>
      ${cart.map((i) => `<p style="color:#f0e8d8;margin:2px 0;font-size:14px;">📕 ${esc(titleOf(i))}${split.qtyOf(i) > 1 ? ` × ${split.qtyOf(i)}` : ''}</p>`).join('')}
      <p style="color:#a09080;margin:8px 0 0;font-size:12px;">${note}</p>
    </div>`;
  const payParent = collect > 0 ? `Pay ₹${collect} for your order with this parcel, as before.` : 'Already paid — nothing to pay on delivery.';
  return `
    <div style="background:#0d0b08;color:#f0e8d8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;">
      <h1 style="color:#c9a84c;font-size:24px;font-weight:400;margin-bottom:4px;">Ink &amp; Chai</h1>
      <p style="color:#a09080;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:28px;">inkandchai.in</p>
      <h2 style="color:#f0e8d8;font-size:20px;font-weight:400;">Your order is coming in ${children.length + 1} parcels 📦</h2>
      <p style="color:#a09080;line-height:1.8;margin:14px 0;">
        Hi ${first}, so the books we have ready reach you sooner, we're sending order
        <strong style="color:#c9a84c;">${pid}</strong> in separate parcels. Each one gets its own tracking.
      </p>
      ${box(`Parcel 1 · ${order.razorpay_order_id || order.id}`, parentCart, payParent)}
      ${children.map((c, k) => box(`Parcel ${k + 2} · ${c.id}`, c.cart, 'Part of the same order — nothing extra to pay.')).join('')}
      <p style="color:#a09080;font-size:13px;line-height:1.8;">You'll get tracking for each parcel as it is dispatched. You can see all of them under My Orders.</p>
      <hr style="border:none;border-top:1px solid #2a2a2a;margin:28px 0;"/>
      <p style="color:#7a6330;font-size:11px;">Ink &amp; Chai · Reply to this email or message us on WhatsApp with any question.</p>
    </div>`;
}

async function notifyCustomer(order, parentCart, children, deps = {}) {
  const result = { email: null, whatsapp: null };
  const collect = collectOnParent(order);
  const pid = order.razorpay_order_id || order.id;
  const first = String(order.customer_name || 'there').trim().split(/\s+/)[0] || 'there';
  if (order.customer_email) {
    try {
      await (deps.sendEmail || sendEmail)({
        to: order.customer_email,
        subject: `📦 Your Ink & Chai order ${pid} is coming in ${children.length + 1} parcels`,
        html: emailHtml(order, parentCart, children, collect),
      });
      result.email = { ok: true };
    } catch (e) { result.email = { ok: false, error: e.message }; }
  } else result.email = { ok: false, skipped: 'no email on record' };

  if (order.customer_phone) {
    try {
      const { sendWhatsApp, sendText } = deps.whatsapp || require('./utils/whatsapp');
      const template = deps.template !== undefined ? deps.template : process.env.WHATSAPP_ORDER_SPLIT_TEMPLATE;
      const ids = children.map((c) => c.id).join(', ');
      const pay = collect > 0 ? ` Please pay ₹${collect} with the parcel for ${pid}; the other parcel${children.length > 1 ? 's have' : ' has'} nothing to pay.` : ' Nothing extra to pay.';
      const text = `Hi ${first}, an update on your Ink & Chai order ${pid}: so the books we have ready reach you sooner, we're sending it in ${children.length + 1} parcels.\n\n`
        + `📦 ${pid}: ${linesText(parentCart)}\n`
        + children.map((c) => `📦 ${c.id}: ${linesText(c.cart)}`).join('\n')
        + `\n\nEach parcel gets its own tracking.${pay} You can see them all under My Orders on inkandchai.in.`;
      const wa = template
        ? await sendWhatsApp({ to: order.customer_phone, template, params: [first, pid, ids] })
        : await sendText(order.customer_phone, text);
      result.whatsapp = wa && wa.ok ? { ok: true, via: template ? 'template' : 'text (delivered only inside the 24 h window)' }
        : { ok: false, error: (wa && (wa.error || wa.status)) || 'not sent' };
    } catch (e) { result.whatsapp = { ok: false, error: e.message }; }
  } else result.whatsapp = { ok: false, skipped: 'no phone on record' };
  return result;
}

async function loadOrder(supabase, ref) {
  let { data } = await supabase.from('orders').select('*').eq('razorpay_order_id', ref).limit(1).maybeSingle();
  if (!data && /^[0-9a-f-]{36}$/i.test(ref)) ({ data } = await supabase.from('orders').select('*').eq('id', ref).limit(1).maybeSingle());
  return data || null;
}

/** Free child ids: -S2, -S3 ... after any earlier split of this order. */
async function allocateIds(supabase, parent, count) {
  const pid = String(parent.razorpay_order_id || parent.id);
  const taken = new Set(split.splitChildren(parent).map((s) => s.toUpperCase()));
  let n = 2 + taken.size;
  const ids = [];
  for (let guard = 0; ids.length < count && guard < 40; guard++, n++) {
    const id = split.childIdFor(pid, n);
    if (taken.has(id.toUpperCase()) || ids.includes(id)) continue;
    const { data } = await supabase.from('orders').select('id').eq('razorpay_order_id', id).limit(1);
    if (data && data.length) continue;
    ids.push(id);
  }
  if (ids.length < count) throw new Error('Could not find free order numbers for the new shipments.');
  return ids;
}

/** XB serves the pincode -> queue; it does not -> NimbusPost; unknown -> owner. */
async function routeChild(event, child, deps = {}) {
  const check = deps.serviceability || require('./admin-xb-serviceability').orderServiceability;
  const v = await check(child);
  if (v.serviceable === true) {
    return { courier: 'xpressbees', done: true, note: `XpressBees serves ${v.pincode}: waiting in the XpressBees queue — book it there like any order.` };
  }
  if (v.serviceable === false) {
    const push = deps.nimbusPush || ((body) => require('./nimbuspost-order-push').handler({
      httpMethod: 'POST', path: '/.netlify/functions/nimbuspost-order-push', headers: event.headers || {}, body: JSON.stringify(body),
    }));
    try {
      const res = await push({ order_ids: [child.razorpay_order_id], xb_unserviceable: true });
      let data = {}; try { data = JSON.parse(res.body || '{}'); } catch { /* reported below */ }
      const sum = data.summary || {};
      const ok = res.statusCode === 200 && Number(sum.pushed || 0) > 0;
      const why = data.error || (sum.errors || [])[0] || (sum.booked_elsewhere || [])[0]
        || ((sum.held_preorders || []).length ? 'held as a pre-order until its release date' : '')
        || (sum.skipped ? 'skipped (already in the panel?)' : '') || `HTTP ${res.statusCode}`;
      return ok
        ? { courier: 'nimbuspost', done: true, note: `XpressBees does not serve ${v.pincode}: pushed to the NimbusPost panel.` }
        : { courier: 'nimbuspost', done: false, note: `XpressBees does not serve ${v.pincode}, and the NimbusPost push did not go through (${String(why).slice(0, 160)}). Push it from the admin.` };
    } catch (e) {
      return { courier: 'nimbuspost', done: false, note: `XpressBees does not serve ${v.pincode}; NimbusPost push failed: ${e.message}. Push it from the admin.` };
    }
  }
  return { courier: null, done: false, note: `Could not tell whether XpressBees serves it (${v.reason || 'no answer'}). It is in the unshipped list — choose the courier yourself.` };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  const block = requireAdmin(event, CORS);
  if (block) return block;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return json(500, { error: 'Supabase is not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const ref = String(body.order_id || '').trim().slice(0, 120);
  if (!ref) return json(400, { error: 'Missing order_id' });
  const dryRun = body.dry_run !== false;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  try {
    const parent = await loadOrder(supabase, ref);
    const refusal = split.splitRefusal(parent);
    if (refusal) return json(parent ? 409 : 404, { error: refusal });

    let plan;
    try { plan = split.planSplit(parent, body.shipments); } catch (e) { return json(400, { error: e.message }); }

    const meta = split.splitMeta(parent) || {};
    if (meta.at && Date.now() - Date.parse(meta.at) < DOUBLE_SUBMIT_MS && !dryRun) {
      return json(409, { error: `This order was split moments ago (${(meta.children || []).join(', ')}). Refresh the orders list before splitting again.` });
    }

    const pid = String(parent.razorpay_order_id || parent.id);
    const booked = !!String(parent.tracking_id || '').trim();
    const ids = await allocateIds(supabase, parent, plan.childCarts.length);
    const now = new Date().toISOString();
    const warnings = [];
    if (booked) warnings.push(`${pid} already has AWB ${parent.tracking_id}: its label and the courier's item list still show every book. Pack only the books listed for ${pid} here.`);
    else if (parent.nimbus_pushed_at || parent.xpressbees_feed_at) warnings.push(`${pid} is already in a courier panel with all its books listed. Pack by the website order, not the panel's item list.`);
    const collect = collectOnParent(parent);
    if (collect > 0) warnings.push(`${pid} is cash on delivery: its parcel still collects the full ₹${collect}. The new shipments collect nothing.`);

    const children = ids.map((id, k) => {
      const cart = plan.childCarts[k].map((l) => ({ ...l }));
      cart[0]._split = { of: pid, n: Number(id.match(/-S(\d+)$/)[1]), at: now, parent_awb: booked ? String(parent.tracking_id) : null };
      return {
        id: crypto.randomUUID(),
        razorpay_order_id: id,
        razorpay_payment_id: null,
        amount_paise: 0,
        status: 'confirmed',
        // Books already sold on the original: never cash on delivery.
        shipment_payment_type: 'prepaid',
        customer_name: parent.customer_name || '',
        customer_email: parent.customer_email || '',
        customer_phone: parent.customer_phone || '',
        customer_address: parent.customer_address || '',
        cart_items: cart,
        ...(parent.user_id ? { user_id: parent.user_id } : {}),
        source: 'split',
      };
    });

    const parentCart = plan.parentCart.map((l) => ({ ...l }));
    const firstSplit = !meta.original_cart;
    parentCart[0]._split = {
      children: [...(meta.children || []), ...ids],
      at: now,
      // The cart as bought, for the invoice: the original still carries the whole payment.
      original_cart: firstSplit
        ? split.parseCart(parent.cart_items).map((l) => { const o = {}; for (const [k, v] of Object.entries(l)) if (!k.startsWith('_')) o[k] = v; return o; })
        : meta.original_cart,
    };

    const preview = {
      order: pid,
      booked_awb: booked ? String(parent.tracking_id) : null,
      keeps: plan.parentCart.map((l) => ({ title: titleOf(l), qty: split.qtyOf(l) })),
      new_shipments: children.map((c) => ({ order: c.razorpay_order_id, books: c.cart_items.map((l) => ({ title: titleOf(l), qty: split.qtyOf(l) })) })),
      collect_on_original_rs: collect,
      warnings,
    };

    if (dryRun) {
      if (booked) {
        // Read-only rate check, so the preview can say where the new parcel goes.
        const check = require('./admin-xb-serviceability').orderServiceability;
        const v = await check({ ...children[0], amount_paise: 0 });
        preview.courier_plan = v.serviceable === true ? `XpressBees serves ${v.pincode}: the new shipment will wait in the XpressBees queue.`
          : v.serviceable === false ? `XpressBees does not serve ${v.pincode}: the new shipment will be pushed to the NimbusPost panel.`
            : `Could not tell whether XpressBees serves it (${v.reason || 'no answer'}): it will wait in the unshipped list for you.`;
      } else {
        preview.courier_plan = 'The new shipment joins the unshipped list and ships like any order.';
      }
      return json(200, { dry_run: true, ...preview });
    }

    // ── Counted stock: hand the moved books' "taken" rows to the children ──
    let movesOk = true; let parentMoves = [];
    const moved = [];
    {
      const { data, error } = await supabase.from('order_stock_moves').select('order_id,slug,qty,returned_at').eq('order_id', String(parent.id));
      if (error) { movesOk = false; console.warn('[admin-split-order] order_stock_moves unreadable:', error.message); }
      else parentMoves = data || [];
    }
    if (movesOk) {
      const s = split.splitStockMoves(parentMoves, plan.childCarts);
      // A '*' marker on every child so the trigger never takes its books again.
      const rows = children.flatMap((c, k) => [{ order_id: c.id, slug: '*', qty: 0 }, ...s.children[k].map((m) => ({ order_id: c.id, ...m }))]);
      const { error } = await supabase.from('order_stock_moves').insert(rows);
      if (error) return json(500, { error: `Could not record the stock hand-over: ${error.message}. Nothing was split.` });
      moved.push(...rows);
      for (const m of s.parent) {
        const before = parentMoves.find((r) => r.slug === m.slug && !r.returned_at);
        if (before && Number(before.qty) !== m.qty) {
          await supabase.from('order_stock_moves').update({ qty: m.qty }).eq('order_id', String(parent.id)).eq('slug', m.slug);
        }
      }
    }
    const undoStock = async () => {
      if (!movesOk) return;
      await supabase.from('order_stock_moves').delete().in('order_id', children.map((c) => c.id));
      for (const r of parentMoves) {
        if (r.slug === '*' || r.returned_at) continue;
        await supabase.from('order_stock_moves').update({ qty: r.qty }).eq('order_id', String(parent.id)).eq('slug', r.slug);
      }
    };

    const { error: insErr } = await supabase.from('orders').insert(children);
    if (insErr) { await undoStock(); return json(500, { error: `Could not create the new shipments: ${insErr.message}. Nothing was split.` }); }

    const { error: updErr } = await supabase.from('orders').update({ cart_items: parentCart }).eq('id', parent.id);
    if (updErr) {
      await supabase.from('orders').delete().in('id', children.map((c) => c.id));
      await undoStock();
      return json(500, { error: `Could not update ${pid}: ${updErr.message}. Nothing was split.` });
    }

    const routes = [];
    for (const c of children) {
      routes.push({ order: c.razorpay_order_id, ...(booked ? await routeChild(event, c) : { courier: null, done: true, note: 'In the unshipped list — ships like any order.' }) });
    }

    const notified = body.notify === false ? { skipped: true }
      : await notifyCustomer(parent, parentCart, children.map((c) => ({ id: c.razorpay_order_id, cart: c.cart_items })));

    return json(200, { success: true, ...preview, routes, notified, stock_moved: movesOk });
  } catch (err) {
    console.error('[admin-split-order]', err);
    return json(500, { error: err.message });
  }
};

exports._test = { notifyCustomer, routeChild, emailHtml };
