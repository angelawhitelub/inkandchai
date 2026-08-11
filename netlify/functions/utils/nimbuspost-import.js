/**
 * Shared helper: push an order to the NimbusPost panel without assigning an AWB.
 *
 * Used by:
 *  - nimbuspost-order-push.js  (admin bulk import)
 *  - cod-order.js, verify-payment.js  (auto-push on order creation)
 *
 * NimbusPost panel API quirks:
 *  - Endpoint: POST https://ship.nimbuspost.com/api/orders/create
 *  - Auth: NP-API-KEY header (env NIMBUSPOST_API_KEY) — NOT the Partners token
 *  - Body: ONLY multipart/form-data — application/json returns 404
 *  - Nested fields: bracket notation, e.g. products[0][name]
 */

const { normalizeIndianPhone, parseAddress, enrichAddress } = require('./np-normalize');
const { isReplacementOrder } = require('./replacement-order');

const NP_ORDER_URL = 'https://ship.nimbuspost.com/api/orders/create';

// NimbusPost's invoice/label PDF renderer can't print non-Latin glyphs — anything
// outside ASCII shows up as "?" (Devanagari titles for Hindi editions, etc.). And
// "double-struck" Unicode used in some catalogue titles (𝔸𝕥𝕠𝕞𝕚𝕔 ℍ𝕒𝕓𝕚𝕥𝕤) doesn't
// render in many panel fonts either. Sanitise to plain ASCII before sending.
function sanitizeForCourier(rawTitle) {
  const original = String(rawTitle || '').trim();
  if (!original) return 'Book';
  // NFKD turns 𝔸 -> A, fi -> fi, etc. Then drop combining marks and non-ASCII.
  const ascii = original
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')        // strip diacritics left by NFKD
    .replace(/[^\x20-\x7E]/g, ' ')          // drop any remaining non-ASCII
    .replace(/\s+/g, ' ')
    .trim();
  // If sanitising removed too much (pure-Devanagari Hindi title, etc.), fall
  // back to "Hindi Book" / generic so the courier still sees a usable line.
  if (ascii.length < 3) return 'Hindi Book';
  return ascii.slice(0, 150);
}

function splitName(value) {
  const tokens = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { first: 'Customer', last: 'Customer' };
  const first = tokens[0].slice(0, 60);
  // NimbusPost's Orders API rejects blank lname with "lname is required". When
  // the customer only gave one name, duplicate the first as the last — matches
  // what the user does manually in the panel anyway.
  const last = tokens.length > 1
    ? tokens.slice(1).join(' ').slice(0, 60)
    : first;
  return { first, last };
}

function parseItems(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try { const v = JSON.parse(value); return Array.isArray(v) ? v : []; } catch { return []; }
}

async function buildPayload(order, opts = {}) {
  const orderId = String(opts.orderNumber || order.razorpay_order_id || order.id);
  const items = parseItems(order.cart_items);
  const amountRs = Math.max(0, Number(order.amount_paise || 0) / 100);
  const itemSubtotal = items.reduce((s, i) => s + (Number(i.price || 0) * Math.max(1, Number(i.qty || i.quantity || 1))), 0);
  const paymentMeta = items[0]?._payment || {};
  // A replacement's cart is copied from the original order, so it inherits that
  // order's _payment meta — including a partial-COD balance that was already
  // collected once. Rule it out before any of the money tests run.
  const isReplacement = isReplacementOrder(order, items);
  // Decide COD on captured money, not on the status label — same rule as
  // nimbuspost-order-push.js. A status-only test ships anything in another
  // status ('confirmed' from the admin dropdown, 'paid' written by the Razorpay
  // webhook before it knew the order was partial COD) as prepaid, and then the
  // courier collects nothing at the door.
  const isPartialCod = !isReplacement && (order.status === 'partial_cod_pending'
    || Number(order.advance_paid_paise || 0) > 0
    || Number(paymentMeta.balance || 0) > 0);
  // What the courier collects. For a replacement amount_paise is authoritative
  // — 0 means free — so the itemSubtotal fallback must NOT apply: the subtotal
  // is what the customer already paid on the original order.
  const collectable = Math.round(isPartialCod
    ? Math.max(0, Number(paymentMeta.balance || 0))
    : (isReplacement ? amountRs : (amountRs || itemSubtotal)));
  const totalQty = items.reduce((s, i) => s + Math.max(1, Number(i.qty || i.quantity || 1)), 0) || 1;
  const name = splitName(order.customer_name);
  const addr = await enrichAddress(parseAddress(order.customer_address));  // fills city/state from pincode
  const phone = normalizeIndianPhone(order.customer_phone);
  const fullyPrepaid = !isPartialCod
    && (Boolean(order.razorpay_payment_id) || String(order.status || '').toLowerCase() === 'paid');
  // A replacement is always a prepaid fulfilment shipment. Its amount is a
  // declared parcel value only; NimbusPost must never collect it at delivery.
  const isCod = !isReplacement && (isPartialCod || (!fullyPrepaid && collectable > 0));
  // `amount` doubles as the declared value of the parcel, so a free replacement
  // still declares the books' worth — it just isn't collected.
  const amount = isCod ? collectable : Math.round(collectable || itemSubtotal);

  if (!phone) throw new Error('Customer phone must contain a valid 10-digit mobile number');
  if (!addr.pincode) throw new Error('Customer address has no 6-digit pincode');
  if (!addr.address) throw new Error('Customer address has no street line — only a city/state/pincode was saved');
  // city/state are derived from the pincode when the address doesn't spell them
  // out, so reaching here almost always means the pincode itself isn't real.
  if (!addr.city || !addr.state) {
    throw new Error(`Pincode ${addr.pincode} did not resolve to a city/state — check it is a real pincode (address: "${addr.address}")`);
  }

  return {
    order_number: orderId,
    // Reverse orders sit in the panel awaiting manual courier assignment —
    // the Orders API skips the /v1/shipments serviceability check that fails
    // for Tier-2/3 pincodes. NP's exact reverse-marker field isn't publicly
    // documented, so we send all common candidates and let their multipart
    // parser use whichever it recognises (unknown keys are silently dropped).
    ...(opts.reverse ? {
      order_type:    'reverse',
      type:          'reverse',
      is_reverse:    1,
      reverse:       1,
      shipment_type: 'reverse',
    } : {}),
    payment_method: isCod ? 'COD' : 'prepaid',
    amount,
    fname: name.first,
    lname: name.last,
    address: addr.address,
    address_2: '',
    phone,
    city: addr.city,
    state: addr.state,
    country: 'India',
    pincode: Number(addr.pincode),
    // Flat 400g / 15×10×5 for every shipment regardless of qty or product mix.
    weight: 400,
    length: 15,
    breadth: 10,
    height: 5,
    products: items.length ? items.map(i => ({
      name: sanitizeForCourier(i.title || i.name || 'Book'),
      qty: Math.max(1, Number(i.qty || i.quantity || 1)),
      price: Math.round(Number(i.price || 0)),
    })) : [{ name: 'Books', qty: 1, price: amount }],
  };
}

function appendFormField(form, key, value) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) value.forEach((v, i) => appendFormField(form, `${key}[${i}]`, v));
  else if (typeof value === 'object') for (const k of Object.keys(value)) appendFormField(form, `${key}[${k}]`, value[k]);
  else form.append(key, String(value));
}

function toFormData(payload) {
  const form = new FormData();
  for (const k of Object.keys(payload)) appendFormField(form, k, payload[k]);
  return form;
}

async function pushOrderToNimbusPost(order, { apiKey, reverse, orderNumber } = {}) {
  const key = apiKey || process.env.NIMBUSPOST_API_KEY;
  if (!key) throw new Error('NIMBUSPOST_API_KEY is not configured');

  const payload = await buildPayload(order, { reverse, orderNumber });
  const res = await fetch(NP_ORDER_URL, {
    method: 'POST',
    // Don't set Content-Type — fetch adds multipart/form-data with the boundary.
    headers: { 'Accept': 'application/json', 'NP-API-KEY': key },
    body: toFormData(payload),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!res.ok || data.status === false || data.success === false || data.error) {
    throw new Error(`NimbusPost order import failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

module.exports = { pushOrderToNimbusPost, buildPayload, toFormData, sanitizeForCourier };
