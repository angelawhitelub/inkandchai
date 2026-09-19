/**
 * Netlify Function: xpressbees-ship
 * POST /.netlify/functions/xpressbees-ship
 *
 * Books XpressBees shipments for website orders: fetch order from Supabase ->
 * quote serviceability -> book -> store the AWB, courier and label back on the
 * order. The twin of nimbuspost-ship.js, and it BOOKS -- unlike
 * ithink-order-push.js, every call here assigns a real AWB and costs money.
 *
 * Body:
 *   { order_id: "IC-..." }                 one order
 *   { order_ids: ["IC-...", ...] }         many
 *   { dry_run: true }                      build + quote, book nothing
 *   { action: "serviceability" }           rates for the first order only
 *   { courier_id: 1 }                      force a courier
 *   { force: true }                        re-book an order that has a tracking id
 *   { cancel_existing: true }              void the current AWB first, then re-book
 *   { suffix: "-p" }                       book under <order id><suffix>, for a re-book
 *
 * Header: X-Admin-Key / X-Admin-Token
 * Env: XPRESSBEES_EMAIL, XPRESSBEES_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_KEY
 *      XPRESSBEES_PICKUP_* (see utils/xpressbees.js pickupFromEnv)
 *      XPRESSBEES_COURIER_PRIORITY  comma-separated name fragments
 */

const { createClient } = require('@supabase/supabase-js');
const { sanitizeForCourier, sanitizeAddressText } = require('./utils/nimbuspost-import');
const { buildTrackingUrl } = require('./utils/tracking-url');
const { normalizeIndianPhone, parseAddress, enrichAddress } = require('./utils/np-normalize');
const { requireAdmin } = require('./utils/admin-auth');
const { isReplacementOrder } = require('./utils/replacement-order');
const { classifyShipmentMoney, parseCartItems } = require('./utils/shipment-money');
const xb = require('./utils/xpressbees');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body, null, 2) });

// Flat box, same as every other push path. XpressBees reweighs at the hub.
const BOX = { weight: 400, length: 15, breadth: 10, height: 5 };

/**
 * The only states a shipment may be cancelled out of.
 *
 * cancel_existing exists to undo a shipment booked with the WRONG PAYMENT
 * MODE: 66 orders reached the panel as COD through the WooCommerce channel,
 * 54 already paid in full and 12 free replacements, because that importer
 * stamps everything COD. Re-booking them prepaid means voiding the AWB first.
 *
 * But a parcel that has already been picked up is out of our hands and in a
 * van. Cancelling its AWB there does not bring it back -- it detaches the only
 * number anyone can trace it by, and the customer's parcel becomes untrackable
 * while still being delivered. So this is an allowlist, not a blocklist: an
 * unrecognised state is refused, and the panel export that says otherwise is
 * not consulted, because an export is a snapshot and this is checked live.
 */
const CANCELLABLE = /^\s*(pending pickup|booked|manifested?|awaiting pickup|data received)\s*$/i;

// www.xpressbees.com drops the AWB, redirects to the site root and shows a
// CAPTCHA. The shipping-platform page deep-links with no login. See
// utils/tracking-url.js, which is the single place this is decided.
const trackUrl = (awb) => buildTrackingUrl({ courier: 'xpressbees', awb });

/**
 * Pick a courier from the serviceability quote.
 *
 * Unlike NimbusPost -- where the ladder spans genuinely different carriers and
 * a silent fallback could put a parcel with one we do not want -- every option
 * here is an XpressBees service tier, so the cheapest serviceable one is the
 * right default. A preference list still wins when set, and an explicit
 * courier_id always wins over both.
 */
function chooseCourier(quotes, { forceId, priority }) {
  const usable = quotes.filter(q => q && (q.id || q.id === 0));
  if (!usable.length) return null;

  if (forceId) {
    const hit = usable.find(q => String(q.id) === String(forceId));
    if (!hit) throw new Error(`Courier ${forceId} is not serviceable for this pincode. Available: ${usable.map(q => `${q.id}=${q.name}`).join(', ')}`);
    return hit;
  }

  for (const pref of priority) {
    const words = pref.split(/\s+/).filter(Boolean);
    const hit = usable.find(q => { const n = String(q.name || '').toLowerCase(); return words.every(w => n.includes(w)); });
    if (hit) return hit;
  }

  return usable.slice().sort((a, b) =>
    (Number(a.total_charges) || Infinity) - (Number(b.total_charges) || Infinity))[0];
}

async function buildOrder(order, suffix = '') {
  const orderId = order.razorpay_order_id || order.id;

  const a = await enrichAddress(parseAddress(order.customer_address || ''));
  if (!/^\d{6}$/.test(String(a.pincode || ''))) throw new Error(`Cannot determine a 6-digit pincode for ${orderId}`);

  const tel = String(normalizeIndianPhone(order.customer_phone || '') || '').replace(/\D/g, '').slice(-10);
  if (tel.length !== 10) throw new Error(`Cannot determine a 10-digit phone for ${orderId} (got "${tel}")`);

  const tidy = (v) => String(v || '').replace(/[\s\-–,]+$/, '').trim();
  const money = classifyShipmentMoney(order, isReplacementOrder(order));

  // order_items prices are informational on the label; order_amount and
  // collectable_amount are what actually bill and collect. Their doc is
  // explicit that the total is NOT derived from the items, so both are sent.
  const items = parseCartItems(order.cart_items).filter(i => i && (i.title || i.name));
  const order_items = items.length
    ? items.map(i => ({
        name: sanitizeForCourier(i.title || i.name || 'Book').slice(0, 200),
        qty: String(Math.max(1, Number(i.qty || i.quantity || 1))),
        sku: String(i.sku || ''),
        price: String(Math.max(0, Number(i.price || 0))),
      }))
    : [{ name: 'Books', qty: '1', sku: '', price: String(money.orderValueRs) }];

  return {
    _meta: {
      order_id: orderId, db_id: order.id,
      booked_as: (String(orderId).slice(0, 20 - suffix.length) + suffix),
      payment_type: money.shipmentPaymentType,
      order_amount: money.orderValueRs,
      collectable: money.collectableAmount,
      pincode: a.pincode,
      lines: order_items.length,
    },
    payload: {
      // XpressBees keeps an order number RESERVED after a cancel: re-booking
      // ten voided shipments under their own numbers failed every time with
      // "Order number already in use", leaving ten parcels with no live AWB.
      // A suffix makes the number new. It is cosmetic to the courier and the
      // real id stays in _meta, on the order row and on the label's items.
      // The 20-char cap is the API's, so the base is trimmed to fit the
      // suffix rather than the suffix being trimmed off the end.
      order_number: (String(orderId).slice(0, 20 - suffix.length) + suffix),
      // unique_order_number is NOT sent: the v1.1.5 doc drops it, and an
      // undocumented field is not where to put double-booking protection.
      // That guard is the tracking_id check in the handler, which is ours.
      payment_type: money.isCOD ? 'cod' : 'prepaid',
      order_amount: money.orderValueRs,
      // Prepaid MUST be zero; COD must be <= order_amount. classifyShipmentMoney
      // already guarantees both, which is the whole reason it is shared.
      collectable_amount: money.collectableAmount,
      package_weight: BOX.weight,
      package_length: BOX.length,
      package_breadth: BOX.breadth,
      package_height: BOX.height,
      request_auto_pickup: 'yes',
      shipping_charges: 0,
      cod_charges: 0,
      discount: 0,
      consignee: {
        // A book-title sanitiser here shipped customers as 'Hindi Book'.
        name: sanitizeAddressText(order.customer_name || '', 60) || 'Customer',
        address: sanitizeAddressText(tidy(a.address) || tidy(a.city) || '', 200),
        address_2: '',
        city: tidy(a.city).slice(0, 40),
        state: tidy(a.state).slice(0, 40),
        pincode: String(a.pincode),
        phone: tel,
      },
      pickup: xb.pickupFromEnv(),
      order_items,
    },
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return json(405, { error: 'Method not allowed' });

  const block = requireAdmin(event, CORS);
  if (block) return block;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const ids = body.order_ids || (body.order_id ? [body.order_id] : []);
  if (!ids.length) return json(400, { error: 'Provide order_id or order_ids' });

  const suffix = String(body.suffix || '');
  if (suffix && !/^[A-Za-z0-9_-]{1,8}$/.test(suffix)) {
    return json(400, { error: `suffix must be 1-8 characters of A-Z, 0-9, - or _ (got ${JSON.stringify(suffix)})` });
  }

  const priority = String(process.env.XPRESSBEES_COURIER_PRIORITY || 'surface')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: orders, error } = await supabase.from('orders').select('*').in('razorpay_order_id', ids);
    if (error) throw error;
    if (!orders?.length) return json(404, { error: 'No orders found for given IDs' });

    const pickupPincode = xb.pickupFromEnv().pincode;

    // Rates only, book nothing.
    if (body.action === 'serviceability') {
      const built = await buildOrder(orders[0], suffix);
      const quotes = await xb.serviceability({
        origin: pickupPincode, destination: built._meta.pincode,
        paymentType: built.payload.payment_type,
        orderAmount: built.payload.order_amount,
        weight: BOX.weight, length: BOX.length, breadth: BOX.breadth, height: BOX.height,
      });
      return json(200, {
        order_id: built._meta.order_id, pincode: built._meta.pincode,
        payment_type: built.payload.payment_type,
        chosen: chooseCourier(quotes, { forceId: body.courier_id, priority }),
        couriers: quotes,
      });
    }

    const booked = [], skipped = [], failed = [];

    for (const order of orders) {
      const orderId = order.razorpay_order_id || order.id;
      // cancel_existing is a re-book by definition, so it implies force.
      const force = !!body.force || !!body.cancel_existing;
      if (order.tracking_id && !force) {
        skipped.push({ order_id: orderId, reason: `already has tracking ${order.tracking_id}` });
        continue;
      }
      let cancelled = null;
      if (order.tracking_id && body.cancel_existing) {
        // Live, never from a stored status: the DB says 'shipped' for all of
        // these and a two-day-old panel export said 'booked' for shipments
        // that were by then in transit.
        let state = '';
        try { state = String((await xb.track(order.tracking_id))?.status || ''); }
        catch (e) {
          failed.push({ order_id: orderId, error: `cannot read live status of ${order.tracking_id}, refusing to cancel blind: ${e.message}` });
          continue;
        }
        if (!CANCELLABLE.test(state)) {
          failed.push({ order_id: orderId, error: `refusing to cancel ${order.tracking_id}: courier reports "${state}"` });
          continue;
        }
        try { cancelled = { awb: order.tracking_id, message: await xb.cancel(order.tracking_id), was: state }; }
        catch (e) {
          failed.push({ order_id: orderId, error: `cancel of ${order.tracking_id} failed, not re-booking: ${e.message}` });
          continue;
        }
      }
      try {
        const built = await buildOrder(order, suffix);

        const quotes = await xb.serviceability({
          origin: pickupPincode, destination: built._meta.pincode,
          paymentType: built.payload.payment_type,
          orderAmount: built.payload.order_amount,
          weight: BOX.weight, length: BOX.length, breadth: BOX.breadth, height: BOX.height,
        });
        const courier = chooseCourier(quotes, { forceId: body.courier_id, priority });
        if (!courier) throw new Error(`No XpressBees service is serviceable for pincode ${built._meta.pincode}`);

        if (body.dry_run) {
          booked.push({ ...built._meta, dry_run: true,
            courier: { id: courier.id, name: courier.name, total_charges: courier.total_charges },
            payload: built.payload });
          continue;
        }

        const res = await xb.book({ ...built.payload, courier_id: String(courier.id) });

        const awb = res.awb_number;
        const assignedAt = new Date().toISOString();
        const update = {
          status: 'shipped',
          tracking_id: awb,
          courier_name: res.courier_name || courier.name || 'XpressBees',
          tracking_url: trackUrl(awb),
          shipped_at: assignedAt,
          awb_assigned_at: assignedAt,
          shipment_payment_type: built._meta.payment_type,
        };
        const { error: updErr } = await supabase.from('orders').update(update).eq('id', order.id);
        if (updErr) console.warn(`[xpressbees-ship] ${orderId} booked as ${awb} but Supabase update failed:`, updErr.message);

        booked.push({
          order_id: orderId, awb,
          booked_as: built._meta.booked_as,
          cancelled_awb: cancelled ? cancelled.awb : undefined,
          courier_name: update.courier_name,
          courier_charges: courier.total_charges,
          collectable: built._meta.collectable,
          label: res.label || null,
          shipment_id: res.shipment_id || null,
          tracking_url: update.tracking_url,
          db_updated: !updErr,
        });
      } catch (err) {
        // A cancel that succeeded before a book that failed leaves the order
        // with NO live AWB. Say so loudly: it is not shipped and nothing else
        // will notice on its own.
        failed.push({
          order_id: orderId,
          error: String(err.message || err),
          cancelled_awb_now_void: cancelled ? cancelled.awb : undefined,
        });
      }
    }

    return json(200, {
      dry_run: !!body.dry_run,
      totals: {
        booked: booked.length, skipped: skipped.length, failed: failed.length,
        collectable_total: booked.reduce((t, b) => t + (Number(b.collectable) || 0), 0),
        freight_total: booked.reduce((t, b) => t + (Number(b.courier_charges) || 0), 0),
      },
      booked, skipped, failed,
    });
  } catch (err) {
    console.error('xpressbees-ship error:', err);
    return json(500, { error: String(err.message || err) });
  }
};

module.exports.CANCELLABLE   = CANCELLABLE;
module.exports.buildOrder    = buildOrder;
module.exports.chooseCourier = chooseCourier;
