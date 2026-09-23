/**
 * Delhivery B2C shipment creation.
 *
 * Env:
 *   DELHIVERY_API_TOKEN    — API token (Delhivery One → Settings → API Setup)
 *   DELHIVERY_PICKUP_NAME  — the registered warehouse name, EXACTLY as it
 *                            appears in the panel. Delhivery documents this as
 *                            "case/space sensitive". Shiprocket had the same
 *                            rule and ours was set to 'warehouse' against an
 *                            account whose only address was called 'Home';
 *                            every push failed silently for weeks. There is no
 *                            API that lists warehouses, so this cannot be
 *                            checked from here -- it has to be read off the
 *                            panel and typed in.
 *   DELHIVERY_BASE         — override for staging
 *
 * THIS BOOKS THE PARCEL. There is no import-and-review step: create.json
 * assigns a waybill straight away and the shipment is live. iThink's
 * order/sync.json imports without booking and order/add.json books, and we
 * deliberately use the importing one there. Delhivery only offers the booking
 * one, so a bulk run here is not reversible the way an iThink sync is -- it
 * has to be cancelled shipment by shipment.
 *
 * THE BODY IS NOT JSON. Delhivery takes a form-style body,
 * "format=json&data=<json>", and their own docs state the JSON must not
 * contain & # % ; or \ -- an ampersand in a customer's address would end the
 * data field early and truncate the shipment. Those five characters are
 * stripped from every string before the payload is built.
 */

const { classifyShipmentMoney } = require('./shipment-money');
const { isReplacementOrder } = require('./replacement-order');
const { parseAddress } = require('./np-normalize');
const { sanitizeForCourier } = require('./nimbuspost-import');

const DEFAULT_BASE = 'https://track.delhivery.com';

// The five characters Delhivery's parser cannot survive, plus the = that would
// split a form field. Replaced with a space rather than deleted so that
// "Flat 3 & 4" does not become "Flat 34".
function dlSafe(value, max = 250) {
  return String(value == null ? '' : value)
    .replace(/[&#%;\\=]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function estimateDims(items) {
  const qty = items.reduce((s, i) => s + (i.qty || 1), 0);
  return {
    weightGrams: Math.max(500, qty * 250),   // Delhivery wants grams, not kg
    length: 22,
    breadth: 14,
    height: Math.max(3, qty * 3),
  };
}

/**
 * Build the shipment object for one order row. Exported so the dry run can
 * show exactly what would be sent without a token or a network call.
 */
function buildShipment(order, pickupName) {
  const inkOrderId = order.razorpay_order_id || order.id;

  // Same rule as every other courier path: what the courier may collect is
  // decided by what is still owed, never by the status label. On partial COD
  // amount_paise is the DEPOSIT and the balance lives in the cart metadata, so
  // this is the only thing that gets it right, and it throws rather than guess.
  const money = classifyShipmentMoney(order, isReplacementOrder(order));

  const addr = parseAddress(order.customer_address);
  const pin  = String(addr.pincode || '').replace(/\D/g, '');
  if (pin.length !== 6) {
    throw new Error(`Cannot determine a 6-digit pincode for ${inkOrderId}`);
  }

  const phone = String(order.customer_phone || '').replace(/\D/g, '').slice(-10);
  if (phone.length !== 10) {
    throw new Error(`Cannot determine a 10-digit phone for ${inkOrderId}`);
  }

  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const dims  = estimateDims(items);
  const desc  = items.length
    ? dlSafe(items.map(i => sanitizeForCourier(i.title || i.name || 'Book')).join(', '), 200)
    : 'Books';
  const qty = items.reduce((s, i) => s + (i.qty || 1), 0) || 1;

  return {
    name:           dlSafe(order.customer_name || 'Customer', 80),
    order:          dlSafe(inkOrderId, 60),
    phone,
    add:            dlSafe(addr.address || order.customer_address, 250),
    pin,
    city:           dlSafe(addr.city, 60),
    state:          dlSafe(addr.state, 60),
    country:        'India',
    payment_mode:   money.isCOD ? 'COD' : 'Prepaid',
    // Delhivery has a real collectable field, unlike Shiprocket where the
    // collectable had to be smuggled in as sub_total. Prepaid must send 0, not
    // '' -- an empty string on a COD-capable account is how parcels go out
    // asking for nothing.
    cod_amount:     money.isCOD ? money.collectableAmount : 0,
    total_amount:   money.orderValueRs,
    products_desc:  desc,
    quantity:       String(qty),
    weight:         String(dims.weightGrams),
    shipment_length: String(dims.length),
    shipment_width:  String(dims.breadth),
    shipment_height: String(dims.height),
    shipping_mode:  process.env.DELHIVERY_SHIPPING_MODE || 'Surface',
    seller_name:    dlSafe(process.env.STORE_NAME || 'Ink & Chai', 60),
    waybill:        '',
    order_date:     order.created_at
      ? new Date(order.created_at).toISOString().slice(0, 19).replace('T', ' ')
      : null,
    _pickup: pickupName,   // stripped before send; kept for the dry run
  };
}

function pickupName() {
  const name = process.env.DELHIVERY_PICKUP_NAME;
  if (!name) throw new Error('DELHIVERY_PICKUP_NAME not set');
  return name;
}

/**
 * Create shipments in one call. Delhivery accepts an array, so a batch is one
 * request rather than one per order.
 */
async function createShipments(orders) {
  const token = process.env.DELHIVERY_API_TOKEN;
  if (!token) throw new Error('DELHIVERY_API_TOKEN not set');
  const base = process.env.DELHIVERY_BASE || DEFAULT_BASE;
  const name = pickupName();

  const shipments = orders.map((o) => {
    const s = buildShipment(o, name);
    delete s._pickup;
    return s;
  });

  const payload = { shipments, pickup_location: { name } };
  const body = `format=json&data=${JSON.stringify(payload)}`;

  const res = await fetch(`${base}/api/cmu/create.json`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      Accept:          'application/json',
      Authorization:   `Token ${token}`,
    },
    body,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Delhivery returned non-JSON (${res.status}): ${text.slice(0, 300)}`); }

  if (!res.ok) throw new Error(`Delhivery create failed (${res.status}): ${JSON.stringify(data).slice(0, 400)}`);
  return data;
}

module.exports = { buildShipment, createShipments, dlSafe, pickupName };
