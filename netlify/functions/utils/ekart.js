/**
 * Ekart (Swift) B2C API.
 *
 *   POST /integrations/v2/auth/token/{client_id}  { username, password } -> access_token (24h)
 *   PUT  /api/v1/package/create                   BOOKS and returns tracking_id
 *   POST /api/v1/package/cancel                   { wbn }
 *   POST /data/v3/serviceability                  which partners cover a lane
 *
 * WHY THIS EXISTS
 * ---------------
 * Delhivery refuses a handful of pincodes outright ("non serviceable pincode")
 * and those orders have nowhere else to go: XpressBees took some by chance,
 * the rest sat unshipped. Ekart is the second lane for exactly those.
 *
 * MONEY comes from classifyShipmentMoney, the single source of truth, so a
 * partial-COD deposit is never re-collected at the door. Never compute a
 * collectable here.
 *
 * PARCEL is the same flat 500g / 15x10x5 every other courier gets -- see
 * utils/delhivery.js for why the dimensions matter (volumetric weight).
 */

const { classifyShipmentMoney } = require('./shipment-money');
const { isReplacementOrder } = require('./replacement-order');
const { parseAddress } = require('./np-normalize');
const { sanitizeForCourier } = require('./nimbuspost-import');

const DEFAULT_BASE = 'https://app.elite.ekartlogistics.in';
const TIMEOUT_MS = 20000;

/** Same flat parcel every courier gets. Quantity and title never change it. */
const FLAT_PARCEL = { weightGrams: 500, length: 15, breadth: 10, height: 5 };

const base = () => String(process.env.EKART_BASE || DEFAULT_BASE).replace(/\/$/, '');

function cfg() {
  const clientId = process.env.EKART_CLIENT_ID;
  const username = process.env.EKART_USERNAME;
  const password = process.env.EKART_PASSWORD;
  if (!clientId) throw new Error('EKART_CLIENT_ID is not set');
  if (!username || !password) throw new Error('EKART_USERNAME / EKART_PASSWORD are not set');
  return { clientId, username, password };
}

async function ekFetch(path, { method = 'GET', token, body, ms = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${base()}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* raw below */ }
    return { httpStatus: res.status, data, raw: text.slice(0, 600) };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { httpStatus: 599, data: null, raw: `Ekart ${path} timed out after ${Math.round(ms / 1000)}s` };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Their token endpoint is a caching one: it hands back the SAME token for 24h,
// so holding it here costs nothing and re-fetching is harmless.
let cached = { token: null, expires: 0 };

async function login({ force = false } = {}) {
  if (!force && cached.token && Date.now() < cached.expires) return cached.token;
  const { clientId, username, password } = cfg();
  const out = await ekFetch(`/integrations/v2/auth/token/${encodeURIComponent(clientId)}`, {
    method: 'POST', body: { username, password },
  });
  const token = out.data && out.data.access_token;
  if (!token) throw new Error(`Ekart login failed (${out.httpStatus}): ${out.data?.message || out.raw}`);
  const ttl = Number(out.data.expires_in || 0) * 1000;
  cached = { token, expires: Date.now() + Math.max(0, ttl - 60000) };
  return token;
}

async function withAuth(fn) {
  let token = await login();
  let out = await fn(token);
  if (out?.httpStatus === 401) {
    token = await login({ force: true });
    out = await fn(token);
  }
  return out;
}

/**
 * Which partners cover this lane, and at what price. Read-only; books nothing.
 *
 * The published spec for this endpoint is WRONG about its input: it validates
 * against the pricing-estimate shape, so it also demands `direction` (which
 * must be UPPERCASE -- "forward" is rejected by enum) and `invoiceAmount`,
 * neither of which appears in serviceability_v3_request. Without them you get
 * SWIFT_VALIDATION_EXCEPTION / SWIFT_MALFORMED_INPUT_EXCEPTION, not an empty
 * partner list -- so a missing field reads like an unserviceable pincode.
 */
async function serviceability({ pickupPincode, dropPincode, paymentType = 'COD', codAmount = '0', invoiceAmount, serviceType = 'SURFACE' }) {
  const body = {
    direction: 'FORWARD',
    pickupPincode: String(pickupPincode),
    dropPincode: String(dropPincode),
    length: String(FLAT_PARCEL.length),
    width: String(FLAT_PARCEL.breadth),
    height: String(FLAT_PARCEL.height),
    weight: String(FLAT_PARCEL.weightGrams),
    paymentMode: paymentType,
    paymentType,
    serviceType,
    codAmount: String(codAmount),
    invoiceAmount: String(invoiceAmount == null ? codAmount : invoiceAmount),
  };
  return withAuth((token) => ekFetch('/data/v3/serviceability', { method: 'POST', token, body }));
}

function pickupLocation() {
  // Ekart autofills a single registered warehouse, and accepts an alias when
  // several exist. Sending a full address block that does not match a
  // REGISTERED one is what gets a booking rejected, so an alias wins when set.
  const alias = process.env.EKART_PICKUP_ALIAS;
  if (alias) return { name: alias };
  return {
    name:     process.env.XPRESSBEES_PICKUP_NAME    || 'Ink and Chai',
    address:  `${process.env.XPRESSBEES_PICKUP_ADDRESS || '2969, Kucha Mai Dass, Sitaram Bazar'}, ${process.env.XPRESSBEES_PICKUP_ADDRESS2 || 'Chandni Chowk'}`,
    city:     process.env.XPRESSBEES_PICKUP_CITY    || 'Delhi',
    state:    process.env.XPRESSBEES_PICKUP_STATE   || 'Delhi',
    country:  'India',
    pin:      Number(process.env.XPRESSBEES_PICKUP_PINCODE || 110006),
    phone:    Number(String(process.env.XPRESSBEES_PICKUP_PHONE || '9625836117').replace(/\D/g, '').slice(-10)),
    location_type: 'Office',
  };
}

/**
 * One order -> one Ekart shipment.
 *
 * Books are zero-rated, so tax_value is 0 and taxable_amount IS the order
 * value; both are overridable by env if that ever stops being true. Their
 * schema wants taxable_amount >= 1, which every real order clears.
 */
function buildShipment(order, suffix = '') {
  const inkOrderId = order.razorpay_order_id || order.id;
  const sentAs = suffix ? `${inkOrderId}${suffix}` : String(inkOrderId);

  const money = classifyShipmentMoney(order, isReplacementOrder(order));
  const addr = parseAddress(order.customer_address);

  const pin = String(addr.pincode || '').replace(/\D/g, '');
  if (pin.length !== 6) throw new Error(`Cannot determine a 6-digit pincode for ${inkOrderId}`);
  const phone = String(order.customer_phone || '').replace(/\D/g, '').slice(-10);
  if (phone.length !== 10) throw new Error(`Cannot determine a 10-digit phone for ${inkOrderId}`);

  const name = sanitizeForCourier(order.customer_name || 'Customer').slice(0, 80);
  const street = sanitizeForCourier(
    [addr.address, addr.address2].filter(Boolean).join(', ') || order.customer_address || '',
  ).slice(0, 240);
  if (!street) throw new Error(`Cannot determine an address for ${inkOrderId}`);

  const total = Number(money.orderValueRs);
  const taxRate = Number(process.env.EKART_TAX_RATE || 0);
  const taxValue = Math.round(total * taxRate * 100) / 100;
  const taxable = Math.round((total - taxValue) * 100) / 100;

  return {
    order_number: sentAs,
    invoice_number: sentAs,
    invoice_date: String(order.created_at || new Date().toISOString()).slice(0, 10),

    seller_name:    process.env.EKART_SELLER_NAME || 'Ink and Chai',
    seller_address: process.env.EKART_SELLER_ADDRESS
      || '2969, Kucha Mai Dass, Sitaram Bazar, Chandni Chowk, Delhi 110006',
    seller_gst_tin: process.env.EKART_SELLER_GST || '',

    consignee_name: name,
    consignee_alternate_phone: phone,   // we hold one number; Ekart wants this field
    consignee_gst_amount: 0,

    payment_mode: money.isCOD ? 'COD' : 'Prepaid',
    cod_amount:   money.isCOD ? Number(money.collectableAmount) : 0,
    total_amount: total,
    tax_value:    taxValue,
    taxable_amount: taxable,
    commodity_value: String(taxable),

    category_of_goods: process.env.EKART_CATEGORY || 'Books',
    products_desc: sanitizeForCourier(process.env.EKART_PRODUCT_DESC || 'Books').slice(0, 120),
    quantity: 1,
    return_reason: '',                  // forward shipment; required key, empty value

    weight: FLAT_PARCEL.weightGrams,
    length: FLAT_PARCEL.length,
    width:  FLAT_PARCEL.breadth,
    height: FLAT_PARCEL.height,

    service: String(process.env.EKART_SERVICE || 'SURFACE').toUpperCase(),

    drop_location: {
      name,
      address: street,
      city:  sanitizeForCourier(addr.city || '').slice(0, 60) || 'NA',
      state: sanitizeForCourier(addr.state || '').slice(0, 60) || 'NA',
      country: 'India',
      pin: Number(pin),
      phone: Number(phone),
      location_type: 'Home',
    },
    pickup_location: pickupLocation(),
    return_location: pickupLocation(),
  };
}

/** Books ONE shipment. Their create is a PUT and returns the waybill inline. */
async function createShipment(payload) {
  return withAuth((token) => ekFetch('/api/v1/package/create', { method: 'PUT', token, body: payload }));
}

async function cancelShipment(wbn) {
  return withAuth((token) => ekFetch('/api/v1/package/cancel', { method: 'POST', token, body: { wbn: String(wbn) } }));
}

/** Their own tracking page, so a direct booking is not sent to NimbusPost's. */
const trackingUrl = (awb) =>
  `${String(process.env.EKART_TRACK_BASE || 'https://ekartlogistics.com/track').replace(/\/$/, '')}/${encodeURIComponent(awb)}`;

module.exports = {
  buildShipment, createShipment, cancelShipment, serviceability,
  login, withAuth, ekFetch, trackingUrl, pickupLocation, FLAT_PARCEL,
};
