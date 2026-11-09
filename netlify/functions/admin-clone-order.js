/**
 * Netlify Function: admin-clone-order   (owner)
 * POST /.netlify/functions/admin-clone-order
 *
 * A fresh copy of an existing order, as a NEW order the couriers treat like any
 * other: for re-sending a parcel that failed delivery or came back, to a
 * corrected address or an alternate number.
 *
 * Body:
 *   order_id          original (razorpay_order_id or uuid)                REQUIRED
 *   items             [{ index, qty }] into the original cart; omitted = every book
 *   payment           'free' (default) -- nothing collected, not a sale (same
 *                       money rules as a replacement or split parcel)
 *                     'cod' -- the courier collects cod_rs; counts as a sale
 *   cod_rs            rupees to collect when payment is 'cod' (> 0)
 *   customer_name / customer_phone / customer_address   optional edits
 *   note              internal note
 *   dry_run           default TRUE: returns the preview, writes nothing
 *
 * The new order is <original>-N2, -N3 ... (kept within XpressBees' 20
 * characters by dropping -CW-). "-N" because the panels strip -C, -P, -D and
 * -R suffixes when matching re-imports, so a "-C2" clone would read as the
 * original there and the double-booking guard would refuse it.
 *
 * Sends the customer nothing. It is booked like any unshipped order, through
 * the same double-booking guard; the shipped message goes out on booking.
 */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const MAX_ID = 20;
const MAX_COPIES = 9;
// Order-level metadata stays on the original; a clone carries only the books.
const ORDER_META = /^_(payment|split|replacement|clone|missing|missing_at|missing_qty|missing_photos)$/;
// Statuses where the original's parcel may still reach the customer.
const LIVE = ['shipped', 'pickup_scheduled', 'processing', 'in_transit', 'out_for_delivery'];

const clean = (v, max = 400) => String(v == null ? '' : v).trim().slice(0, max);
const qtyOf = (i) => Math.max(1, Math.floor(Number(i && (i.qty || i.quantity)) || 1));
const titleOf = (i) => String((i && (i.title || i.name)) || 'Book');

function parseCart(cart) {
  if (Array.isArray(cart)) return cart;
  try { const p = JSON.parse(cart || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
}

/** The order a clone is OF: a clone of a clone points back to the first order. */
function cloneRoot(order) {
  const meta = parseCart(order.cart_items)[0]?._clone;
  return String((meta && meta.of) || order.razorpay_order_id || order.id);
}

/** <root>-N<n>, within 20 characters. */
function cloneIdFor(root, n) {
  const id = `${root}-N${n}`;
  if (id.length <= MAX_ID) return id;
  const short = `${String(root).replace(/^IC-CW-/i, 'IC-')}-N${n}`;
  return short.length <= MAX_ID ? short : `${String(root).slice(0, MAX_ID - 3 - String(n).length)}-N${n}`;
}

/** Validate and build the clone's cart. Throws with a message for the owner. */
function planCart(order, items) {
  const cart = parseCart(order.cart_items);
  if (!cart.length) throw new Error('This order has no books recorded, so there is nothing to copy.');
  const picks = Array.isArray(items) && items.length
    ? items
    : cart.map((line, index) => ({ index, qty: qtyOf(line) }));
  const out = [];
  for (const sel of picks) {
    const idx = Number(sel && sel.index);
    const qty = Math.floor(Number(sel && sel.qty) || 0);
    if (!Number.isInteger(idx) || !cart[idx]) throw new Error(`Book ${idx + 1} is not in this order.`);
    if (qty <= 0) continue;
    if (qty > 20) throw new Error(`"${titleOf(cart[idx])}": at most 20 copies.`);
    const line = {};
    for (const [k, v] of Object.entries(cart[idx])) if (!ORDER_META.test(k)) line[k] = v;
    line.qty = qty;
    if ('quantity' in line) line.quantity = qty;
    out.push(line);
  }
  if (!out.length) throw new Error('Choose at least one book.');
  return out;
}

function phoneOk(p) {
  const d = String(p || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(d);
}

/** Pure: everything about the new row except its id and the db. */
function buildClone(order, body, now = new Date().toISOString()) {
  const payment = body.payment === 'cod' ? 'cod' : 'free';
  const codRs = payment === 'cod' ? Math.round(Number(body.cod_rs) || 0) : 0;
  if (payment === 'cod' && (codRs <= 0 || codRs > 50000)) throw new Error('Enter the amount the courier should collect (₹1 to ₹50,000).');
  const cart = planCart(order, body.items);
  const name = clean(body.customer_name, 120) || order.customer_name || '';
  const phone = clean(body.customer_phone, 20) || order.customer_phone || '';
  const address = clean(body.customer_address, 600) || order.customer_address || '';
  if (!phoneOk(phone)) throw new Error(`"${phone}" is not a 10-digit Indian mobile number.`);
  if (!/\b\d{6}\b/.test(address)) throw new Error('The address needs a 6-digit pincode.');
  const of = cloneRoot(order);
  cart[0]._clone = {
    of,
    from: String(order.razorpay_order_id || order.id),
    at: now,
    payment,
    note: clean(body.note, 500) || null,
    by: 'admin',
    original_awb: String(order.tracking_id || '').trim() || null,
  };
  const row = {
    razorpay_payment_id: null,
    amount_paise: codRs * 100,
    status: payment === 'cod' ? 'cod_pending' : 'confirmed',
    shipment_payment_type: payment === 'cod' ? 'cod' : 'prepaid',
    customer_name: name,
    customer_email: order.customer_email || '',
    customer_phone: phone,
    customer_address: address,
    cart_items: cart,
    ...(order.user_id ? { user_id: order.user_id } : {}),
    source: 'clone',
  };
  const warnings = [];
  const st = String(order.status || '').toLowerCase();
  const awb = String(order.tracking_id || '').trim();
  if (awb && LIVE.includes(st)) {
    warnings.push(`${order.razorpay_order_id} is still "${st}" with ${order.courier_name || 'the courier'} (AWB ${awb}). If that parcel is delivered too, the customer gets two. Cancel it or mark it RTO with the courier.`);
  } else if (!awb && ['paid', 'confirmed', 'cod_pending', 'partial_cod_pending', 'replacement_pending'].includes(st)) {
    warnings.push(`${order.razorpay_order_id} has not shipped yet. Both orders will now wait in the unshipped list; cancel one of them unless you mean to send two parcels.`);
  }
  if (phone !== (order.customer_phone || '')) warnings.push(`Phone changed: ${order.customer_phone || '(none)'} → ${phone}.`);
  if (address !== (order.customer_address || '')) warnings.push('Address changed.');
  return { row, payment, codRs, warnings };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;

  let body;
  try { body = JSON.parse(event.body || '{}') || {}; } catch { return json(400, { error: 'Invalid JSON' }); }
  const ref = clean(body.order_id, 120);
  if (!ref) return json(400, { error: 'Missing order_id' });
  const dryRun = body.dry_run !== false;

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    let { data: order } = await supabase.from('orders').select('*').eq('razorpay_order_id', ref).limit(1).maybeSingle();
    if (!order) order = (await supabase.from('orders').select('*').eq('id', ref).limit(1).maybeSingle()).data || null;
    if (!order) return json(404, { error: 'Order not found' });

    let built;
    try { built = buildClone(order, body); } catch (e) { return json(400, { error: e.message }); }

    // Next free -N<n>, looking at both the long and the -CW-dropped spelling.
    const root = built.row.cart_items[0]._clone.of;
    const candidates = Array.from({ length: MAX_COPIES - 1 }, (_, k) => cloneIdFor(root, k + 2));
    const { data: taken, error: takenErr } = await supabase.from('orders').select('razorpay_order_id').in('razorpay_order_id', candidates);
    if (takenErr) return json(503, { error: `Could not check existing copies: ${takenErr.message}` });
    const used = new Set((taken || []).map((r) => String(r.razorpay_order_id).toUpperCase()));
    const cloneId = candidates.find((c) => !used.has(c.toUpperCase()));
    if (!cloneId) return json(409, { error: `${root} already has ${MAX_COPIES - 1} copies.` });
    if (used.size) built.warnings.push(`Earlier copies: ${[...used].join(', ')}.`);

    const preview = {
      order: String(order.razorpay_order_id || order.id),
      new_order: cloneId,
      books: built.row.cart_items.map((l) => ({ title: titleOf(l), qty: qtyOf(l) })),
      payment: built.payment,
      collect_rs: built.codRs,
      ship_to: { name: built.row.customer_name, phone: built.row.customer_phone, address: built.row.customer_address },
      warnings: built.warnings,
    };
    if (dryRun) return json(200, { dry_run: true, ...preview });

    const { error: insErr } = await supabase.from('orders').insert({ id: crypto.randomUUID(), razorpay_order_id: cloneId, ...built.row });
    if (insErr) return json(500, { error: `Could not create ${cloneId}: ${insErr.message}` });
    return json(200, { success: true, ...preview, note: `${cloneId} is in the unshipped list. Book it like any order; the customer hears from us when it ships.` });
  } catch (err) {
    console.error('[admin-clone-order]', err);
    return json(500, { error: err.message });
  }
};

exports._test = { buildClone, cloneIdFor, cloneRoot, planCart };
