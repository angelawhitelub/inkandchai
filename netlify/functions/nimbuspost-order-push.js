/**
 * Push website orders into the NimbusPost panel without assigning a courier or
 * generating an AWB. Uses NimbusPost's custom-order API (not Partners API).
 *
 * POST body: { order_ids: ["IC-...", ...] } or { all_unshipped: true }
 * Header: X-Admin-Key: <admin password>
 * Required env: NIMBUSPOST_API_KEY
 */

const { createClient } = require('@supabase/supabase-js');

const NP_ORDER_URL = 'https://ship.nimbuspost.com/api/orders/create';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

const UNSHIPPED_STATUSES = [
  'paid', 'confirmed', 'cod_pending', 'partial_cod_pending',
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
    weight: Math.max(300, totalQty * 300),
    length: 22,
    breadth: 15,
    height: Math.max(4, totalQty * 3),
    products: items.length ? items.map(item => ({
      name: String(item.title || item.name || 'Book').slice(0, 150),
      qty: Math.max(1, Number(item.qty || item.quantity || 1)),
      price: Math.round(Number(item.price || 0)),
    })) : [{ name: 'Books', qty: 1, price: amount }],
  };
}

async function pushOrder(order, apiKey) {
  const payload = buildPayload(order);
  const response = await fetch(NP_ORDER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'NP-API-KEY': apiKey,
    },
    body: JSON.stringify(payload),
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

  const sentKey = event.headers['x-admin-key'] || event.headers['X-Admin-Key'] || '';
  if (sentKey !== process.env.ADMIN_SECRET && sentKey !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

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

    const summary = { pushed: 0, skipped: 0, failed: 0, errors: [] };
    for (const order of orders || []) {
      try {
        await pushOrder(order, apiKey);
        summary.pushed++;
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
      body: JSON.stringify({ summary, errors: summary.errors }),
    };
  } catch (err) {
    console.error('[nimbuspost-order-push]', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
