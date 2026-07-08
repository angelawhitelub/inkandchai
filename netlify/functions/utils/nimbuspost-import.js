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

function parseAddress(value) {
  const parts = String(value || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return { address: '', city: '', state: '', pincode: '' };
  // Find a 6-digit pincode in any segment; what comes before it is city/state.
  let pinIdx = parts.findIndex(p => /^\d{6}$/.test(p));
  let pincode = '';
  if (pinIdx >= 0) { pincode = parts[pinIdx]; parts.splice(pinIdx, 1); }
  else {
    const last = parts[parts.length - 1] || '';
    const m = last.match(/\b(\d{6})\b/);
    if (m) { pincode = m[1]; parts[parts.length - 1] = last.replace(m[1], '').replace(/[,\s-]+$/, '').trim() || ''; }
  }
  const state = (parts.pop() || '').slice(0, 64);
  const city  = (parts.pop() || '').slice(0, 64);
  const address = parts.join(', ').slice(0, 200);
  return { address, city, state, pincode };
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

function buildPayload(order, opts = {}) {
  const orderId = String(opts.orderNumber || order.razorpay_order_id || order.id);
  const items = parseItems(order.cart_items);
  const amountRs = Math.max(0, Number(order.amount_paise || 0) / 100);
  const itemSubtotal = items.reduce((s, i) => s + (Number(i.price || 0) * Math.max(1, Number(i.qty || i.quantity || 1))), 0);
  const paymentMeta = items[0]?._payment || {};
  const isPartialCod = order.status === 'partial_cod_pending';
  const amount = Math.round(isPartialCod
    ? Math.max(0, Number(paymentMeta.balance || 0))
    : (amountRs || itemSubtotal));
  const totalQty = items.reduce((s, i) => s + Math.max(1, Number(i.qty || i.quantity || 1)), 0) || 1;
  const name = splitName(order.customer_name);
  const addr = parseAddress(order.customer_address);
  const phone = String(order.customer_phone || '').replace(/\D/g, '').slice(-10);
  const isCod = ['cod_pending', 'partial_cod_pending'].includes(order.status);

  if (!phone || phone.length !== 10) throw new Error('Customer phone must contain 10 digits');
  if (!addr.pincode) throw new Error('Customer address has no 6-digit pincode');
  if (!addr.city || !addr.state) throw new Error('Customer address must include city and state');

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
    phone: Number(phone),
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

  const payload = buildPayload(order, { reverse, orderNumber });
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
