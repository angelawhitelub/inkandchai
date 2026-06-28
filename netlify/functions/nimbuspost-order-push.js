/**
 * Push website orders into the NimbusPost panel without assigning a courier or
 * generating an AWB. Uses NimbusPost's custom-order API (not Partners API).
 *
 * POST body: { order_ids: ["IC-...", ...] } or { all_unshipped: true }
 * Header: X-Admin-Key: <admin password>
 * Required env: NIMBUSPOST_API_KEY
 */

const { createClient } = require('@supabase/supabase-js');
const { sanitizeForCourier } = require('./utils/nimbuspost-import');
const { requireAdmin } = require('./utils/admin-auth');

const NP_ORDER_URL = 'https://ship.nimbuspost.com/api/orders/create';
const NP_ORDERS_URL = 'https://ship.nimbuspost.com/api/orders';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

const UNSHIPPED_STATUSES = [
  'paid', 'confirmed', 'cod_pending', 'partial_cod_pending',
  'replacement_pending',
];

function parseAddress(value) {
  const raw = String(value || '').trim();
  const pinMatch = raw.match(/\b(\d{6})\b/);
  const pincode = pinMatch ? pinMatch[1] : '';
  const parts = raw
    .replace(pincode, '')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*$/, '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

  const state = parts.pop() || '';
  const city = parts.pop() || '';
  return {
    address: parts.join(', ') || raw,
    city,
    state,
    pincode,
  };
}

function parseItems(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function splitName(value) {
  const parts = String(value || 'Customer').trim().split(/\s+/).filter(Boolean);
  const first = parts.shift() || 'Customer';
  return { first, last: parts.join(' ') || '.' };
}

function buildPayload(order) {
  const orderId = String(order.razorpay_order_id || order.id);
  const items = parseItems(order.cart_items);
  const amountRs = Math.max(0, Number(order.amount_paise || 0) / 100);
  const itemSubtotal = items.reduce((sum, item) => {
    return sum + (Number(item.price || 0) * Math.max(1, Number(item.qty || item.quantity || 1)));
  }, 0);
  const paymentMeta = items[0]?._payment || {};
  const isPartialCod = order.status === 'partial_cod_pending';
  // For partial COD, NimbusPost must collect only the outstanding balance.
  // For every other payment type, use the final charged/order amount so coupon
  // discounts are preserved instead of rebuilding the undiscounted subtotal.
  const amount = Math.round(isPartialCod
    ? Math.max(0, Number(paymentMeta.balance || 0))
    : (amountRs || itemSubtotal));
  const totalQty = items.reduce((sum, item) => sum + Math.max(1, Number(item.qty || item.quantity || 1)), 0) || 1;
  const name = splitName(order.customer_name);
  const address = parseAddress(order.customer_address);
  const phone = String(order.customer_phone || '').replace(/\D/g, '').slice(-10);
  const isCod = ['cod_pending', 'partial_cod_pending'].includes(order.status);

  if (!phone || phone.length !== 10) throw new Error('Customer phone must contain 10 digits');
  if (!address.pincode) throw new Error('Customer address has no 6-digit pincode');
  if (!address.city || !address.state) throw new Error('Customer address must include city and state');

  return {
    order_number: orderId,
    payment_method: isCod ? 'COD' : 'prepaid',
    amount,
    fname: name.first,
    lname: name.last,
    address: address.address,
    address_2: '',
    phone: Number(phone),
    city: address.city,
    state: address.state,
    country: 'India',
    pincode: Number(address.pincode),
    // Flat 400g / 15×10×5 for every shipment regardless of qty or product mix.
    weight: 400,
    length: 15,
    breadth: 10,
    height: 5,
    products: items.length ? items.map(item => ({
      name: sanitizeForCourier(item.title || item.name || 'Book'),
      qty: Math.max(1, Number(item.qty || item.quantity || 1)),
      price: Math.round(Number(item.price || 0)),
    })) : [{ name: 'Books', qty: 1, price: amount }],
  };
}

// Flatten a payload object into FormData using bracket notation for nested
// values: { products: [{ name: 'x' }] } -> products[0][name] = 'x'.
// NimbusPost's panel API (/api/orders/create) ONLY accepts multipart/form-data;
// it 404s with "Invalid Content-Type" on application/json.
function appendFormField(form, key, value) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => appendFormField(form, `${key}[${i}]`, v));
  } else if (typeof value === 'object') {
    for (const k of Object.keys(value)) appendFormField(form, `${key}[${k}]`, value[k]);
  } else {
    form.append(key, String(value));
  }
}

function toFormData(payload) {
  const form = new FormData();
  for (const k of Object.keys(payload)) appendFormField(form, k, payload[k]);
  return form;
}

function orderRowsFromResponse(payload) {
  const candidates = [
    payload?.data?.data,
    payload?.data?.orders,
    payload?.data,
    payload?.orders,
    payload?.results,
    payload,
  ];
  return candidates.find(Array.isArray) || [];
}

function paginationFromResponse(payload) {
  const sources = [payload?.data, payload?.meta, payload?.pagination, payload];
  for (const source of sources) {
    if (!source || Array.isArray(source) || typeof source !== 'object') continue;
    const current = Number(source.current_page || source.page || 0);
    const last = Number(source.last_page || source.total_pages || source.pages || 0);
    if (current || last) return { current, last };
  }
  return { current: 0, last: 0 };
}

function normalizeOrderNumber(value) {
  return String(value ?? '').trim().toUpperCase();
}

// NimbusPost does not enforce unique order_number values, so we read the panel
// first and deduplicate ourselves. We only scan the MOST RECENT few pages
// (newest-first): the orders we push are unshipped (recent), so a duplicate can
// only be a recently-pushed order — it will be on these pages. Scanning the
// whole panel (1700+ orders, up to 50 sequential calls) just times the function
// out and returns an HTML error. NimbusPost also hard-caps `page` at 50.
const NP_MAX_PAGE = 50;    // NimbusPost rejects page > 50
const NP_SCAN_PAGES = 5;   // recent pages are enough to catch re-pushes; keeps us well under the function timeout

async function getExistingOrderNumbers(apiKey) {
  const existing = new Set();
  const perPage = 100;
  const lastPage = Math.min(NP_SCAN_PAGES, NP_MAX_PAGE);

  for (let page = 1; page <= lastPage; page++) {
    const url = new URL(NP_ORDERS_URL);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('sort', 'desc');   // newest orders first (NimbusPost wants lowercase)
    url.searchParams.set('sort_by', 'id');

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json', 'NP-API-KEY': apiKey },
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = { message: text }; }

    if (!response.ok || payload.status === false || payload.success === false || payload.error) {
      // NimbusPost is fussy about pagination/sort params and caps `page` at 50.
      // On a param-validation 404 (e.g. page over the cap, or an unsupported
      // sort value) stop with the orders gathered so far rather than aborting
      // the whole import — partial newest-first coverage still dedupes recent
      // orders, which is where collisions happen.
      const msg = JSON.stringify(payload).toLowerCase();
      if (response.status === 404 && /(page|sort).*(must|one of|less than)/.test(msg)) break;
      throw new Error(`NimbusPost duplicate preflight failed (${response.status}): ${JSON.stringify(payload).slice(0, 500)}`);
    }

    const rows = orderRowsFromResponse(payload);
    for (const row of rows) {
      const number = normalizeOrderNumber(
        row?.order_number || row?.order_no || row?.channel_order_id ||
        row?.channel_order_number || row?.order_reference ||
        row?.order?.order_number || row?.order_id
      );
      if (number) existing.add(number);
    }

    const pagination = paginationFromResponse(payload);
    if (!rows.length) break;
    if (pagination.last ? page >= pagination.last : rows.length < perPage) break;
    // Otherwise keep going until we hit NP_MAX_PAGE, then stop gracefully.
  }

  return existing;
}

async function pushOrder(order, apiKey) {
  const payload = buildPayload(order);
  const response = await fetch(NP_ORDER_URL, {
    method: 'POST',
    headers: {
      // Do NOT set Content-Type — fetch will add multipart/form-data with the
      // correct boundary automatically when body is a FormData instance.
      'Accept': 'application/json',
      'NP-API-KEY': apiKey,
    },
    body: toFormData(payload),
  });

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { message: text }; }

  if (!response.ok || data.status === false || data.success === false || data.error) {
    throw new Error(`NimbusPost order import failed (${response.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;

  const apiKey = process.env.NIMBUSPOST_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({
      error: 'NIMBUSPOST_API_KEY is not configured in Netlify.',
    }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    let query = supabase.from('orders').select('*').or('source.is.null,source.neq.paperbound');

    if (body.all_unshipped) {
      query = query.in('status', UNSHIPPED_STATUSES).order('created_at', { ascending: false }).limit(500);
    } else if (Array.isArray(body.order_ids) && body.order_ids.length) {
      query = query.in('razorpay_order_id', body.order_ids);
    } else {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({
        error: 'Provide order_ids or all_unshipped:true',
      }) };
    }

    const { data: orders, error } = await query;
    if (error) throw error;

    // Dedup is best-effort: if the panel lookup fails, proceed with the push
    // and flag it, rather than blocking the whole import.
    let existingOrderNumbers = new Set();
    let dedupWarning = null;
    try {
      existingOrderNumbers = await getExistingOrderNumbers(apiKey);
    } catch (err) {
      dedupWarning = `Duplicate pre-check skipped (${String(err.message || err).slice(0, 160)}). Orders were still pushed.`;
      console.warn('[nimbuspost-order-push] preflight skipped:', err.message);
    }
    const summary = { pushed: 0, skipped: 0, failed: 0, errors: [] };
    for (const order of orders || []) {
      const orderNumber = normalizeOrderNumber(order.razorpay_order_id || order.id);
      if (existingOrderNumbers.has(orderNumber)) {
        summary.skipped++;
        continue;
      }

      try {
        await pushOrder(order, apiKey);
        summary.pushed++;
        // Also protects against repeated rows in this same request.
        existingOrderNumbers.add(orderNumber);
      } catch (err) {
        const message = String(err.message || err);
        if (/already|duplicate|exists/i.test(message)) {
          summary.skipped++;
        } else {
          summary.failed++;
          summary.errors.push(`${order.razorpay_order_id || order.id}: ${message.slice(0, 220)}`);
        }
      }
      if ((orders || []).length > 5) await new Promise(resolve => setTimeout(resolve, 250));
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ summary, errors: summary.errors, warning: dedupWarning }),
    };
  } catch (err) {
    console.error('[nimbuspost-order-push]', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
