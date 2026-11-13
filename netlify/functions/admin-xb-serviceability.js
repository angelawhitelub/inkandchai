/**
 * POST /.netlify/functions/admin-xb-serviceability   (admin)
 * Body: {}  -> every unshipped order (same set the NimbusPost panel push uses)
 *
 * Which unshipped orders can XpressBees deliver? The admin's "Push to
 * NimbusPost Panel" asks this first so the operator can send only the orders
 * XpressBees cannot serve to NimbusPost, and keep the rest for XpressBees.
 *
 * READ-ONLY at XpressBees: only /courier/serviceability (a rate check). Nothing
 * is booked, queued or charged. One check per distinct pincode + payment mode
 * (COD can be refused where prepaid is not), saved for 24 h. A definite answer
 * is cached; a network or sign-in failure is reported as "unknown", never as
 * "not serviceable", and is not cached.
 *
 * Held orders (pre-order, or extra handling time not yet over) carry `held`
 * and are counted under counts.held, not serviceable / not_serviceable: the
 * NimbusPost push holds them back, so counting them as ready overstated it.
 * Booked rows carry awb / courier / last scan so the dialog can list them.
 */
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const xb = require('./utils/xpressbees');
const { parseAddress } = require('./utils/np-normalize');
const { classifyShipmentMoney } = require('./utils/shipment-money');
const { isReplacementOrder } = require('./utils/replacement-order');
const { classifyXbError } = require('./utils/xpressbees-errors');
const { preorderChecker } = require('./utils/preorder-hold');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// Kept equal to nimbuspost-order-push's all_unshipped set.
const UNSHIPPED_STATUSES = ['paid', 'confirmed', 'cod_pending', 'partial_cod_pending', 'replacement_pending'];
const TTL_MS = 24 * 60 * 60 * 1000;
const CONCURRENCY = 6;
const STORE = 'xb-serviceability';

function store() {
  try { return require('@netlify/blobs').getStore(STORE); } catch { return null; }
}

/** quotes -> true/false; thrown error -> false only when XpressBees said "not serviceable". */
function verdict(quotes, err) {
  if (!err) return { serviceable: Array.isArray(quotes) && quotes.length > 0, reason: quotes && quotes.length ? '' : 'no XpressBees service' };
  const kind = classifyXbError(err.message).kind;
  if (kind === 'pincode' || kind === 'no_service') return { serviceable: false, reason: String(err.message).slice(0, 140) };
  return { serviceable: null, reason: String(err.message).slice(0, 140) };
}

async function checkKey(kv, origin, pincode, payment, amount) {
  const key = `${origin}:${pincode}:${payment}`;
  if (kv) {
    try {
      const hit = await kv.get(key, { type: 'json' });
      if (hit && Date.now() - hit.at < TTL_MS) return { ...hit, cached: true };
    } catch { /* fall through to a live check */ }
  }
  let quotes = null; let err = null;
  try {
    quotes = await xb.serviceability({ origin, destination: pincode, paymentType: payment, orderAmount: amount, weight: 500, length: 10, breadth: 10, height: 10 });
  } catch (e) { err = e; }
  const v = verdict(quotes, err);
  if (kv && v.serviceable !== null) {
    try { await kv.set(key, JSON.stringify({ ...v, at: Date.now() })); } catch { /* cache is optional */ }
  }
  return v;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS);
  if (block) return block;
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let origin;
  try { origin = xb.pickupFromEnv().pincode; } catch (e) { return json(500, { error: `XpressBees pickup not configured: ${e.message}` }); }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: rows, error } = await supabase.from('orders').select('*')
    .or('source.is.null,source.neq.paperbound')
    .in('status', UNSHIPPED_STATUSES)
    .order('created_at', { ascending: false }).limit(500);
  if (error) return json(500, { error: error.message });

  // Orders the push itself would hold back (pre-order, or extra handling time
  // whose handover date has not come). Counted apart so the dialog's numbers
  // match what a push will really send; the owner can release the handling
  // ones from the dialog ("Push anyway"). Unreadable settings = no holds shown.
  let holdFor = () => null;
  try { holdFor = await preorderChecker(supabase); } catch (e) { console.error('[admin-xb-serviceability] holds unreadable:', e.message); }

  const orders = [];
  const keys = new Map();
  for (const o of rows || []) {
    const id = o.razorpay_order_id || o.id;
    const booked = String(o.tracking_id || '').trim();
    if (booked) {
      orders.push({
        order: id, serviceable: null, reason: 'already has an AWB', booked: true,
        awb: booked, courier: o.courier_name || '', scan: o.last_courier_status || '', status: o.status,
        created: o.created_at,
      });
      continue;
    }
    let held = null;
    try {
      const h = holdFor(o);
      if (h) held = { kind: h.kind, release: h.release, titles: h.titles || [] };
    } catch { /* treat as not held */ }
    const pincode = parseAddress(o.customer_address || '').pincode;
    if (!/^\d{6}$/.test(String(pincode || ''))) { orders.push({ order: id, serviceable: null, reason: 'no readable pincode', ...(held && { held }) }); continue; }
    let payment = 'prepaid'; let amount = Number(o.amount_paise || 0) / 100;
    try {
      const m = classifyShipmentMoney(o, isReplacementOrder(o));
      payment = m.isCOD ? 'cod' : 'prepaid'; amount = m.orderValueRs;
    } catch { /* keep defaults */ }
    const key = `${pincode}:${payment}`;
    if (!keys.has(key)) keys.set(key, { pincode, payment, amount });
    orders.push({ order: id, pincode, payment, key, ...(held && { held }) });
  }

  const kv = store();
  const results = new Map();
  const list = [...keys.entries()];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
    while (next < list.length) {
      const [key, k] = list[next++];
      results.set(key, await checkKey(kv, origin, k.pincode, k.payment, k.amount));
    }
  }));

  const counts = {
    orders: orders.length, serviceable: 0, not_serviceable: 0, unknown: 0, booked: 0,
    held: 0, held_handling: 0, held_preorder: 0, pincodes_checked: list.length,
  };
  for (const o of orders) {
    if (o.key) { const v = results.get(o.key) || { serviceable: null, reason: 'not checked' }; o.serviceable = v.serviceable; o.reason = v.reason; delete o.key; }
    if (o.booked) counts.booked += 1;
    else if (o.held) { counts.held += 1; counts[o.held.kind === 'preorder' ? 'held_preorder' : 'held_handling'] += 1; }
    else if (o.serviceable === true) counts.serviceable += 1;
    else if (o.serviceable === false) counts.not_serviceable += 1;
    else counts.unknown += 1;
  }
  return json(200, { origin, counts, orders });
};

/**
 * One order: can XpressBees deliver it? { serviceable: true|false|null, reason, pincode }.
 * null = could not tell (no pincode, sign-in or network failure). Read-only.
 */
async function orderServiceability(order) {
  let origin;
  try { origin = xb.pickupFromEnv().pincode; } catch (e) { return { serviceable: null, reason: `XpressBees pickup not configured: ${e.message}` }; }
  const pincode = parseAddress((order && order.customer_address) || '').pincode;
  if (!/^\d{6}$/.test(String(pincode || ''))) return { serviceable: null, reason: 'no readable pincode' };
  let payment = 'prepaid'; let amount = Number((order && order.amount_paise) || 0) / 100;
  try {
    const m = classifyShipmentMoney(order, isReplacementOrder(order));
    payment = m.isCOD ? 'cod' : 'prepaid'; amount = m.orderValueRs;
  } catch { /* keep defaults */ }
  const v = await checkKey(store(), origin, pincode, payment, amount);
  return { serviceable: v.serviceable, reason: v.reason || '', pincode, payment };
}

exports.orderServiceability = orderServiceability;
exports._test = { verdict };
