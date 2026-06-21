/**
 * Netlify Function: process-return
 * POST /.netlify/functions/process-return
 *
 * Admin endpoint — create a NimbusPost reverse pickup for a return request.
 *
 * Pickup:      customer's delivery address
 * Destination: 2969, Kucha Mai Dass, Sitaram Bazar, Delhi - 110006
 *
 * Required env vars:
 *   NIMBUSPOST_EMAIL
 *   NIMBUSPOST_PASSWORD
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   ADMIN_SECRET
 *
 * Body: { return_request_id: "uuid" }
 *       OR { order_display_id: "IC-..." } to look up by order ID
 */

const { createClient } = require('@supabase/supabase-js');

const NP_BASE = 'https://api.nimbuspost.com/v1';

// ── Our warehouse / return destination ────────────────────────────────────
const RETURN_ADDRESS = {
  name:    'Ink and Chai',
  address: '2969, Kucha Mai Dass, Sitaram Bazar',
  city:    'Delhi',
  state:   'Delhi',
  pincode: '110006',
  phone:   '9999999999', // fallback — NimbusPost requires a phone
};

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

// ── Address parser ─────────────────────────────────────────────────────────
function parseAddress(addr) {
  if (!addr) return { addr1: '', city: '', state: '', pincode: '' };
  const parts = addr.split(',').map(p => p.trim()).filter(Boolean);

  let pincode = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = parts[i].match(/\b(\d{6})\b/);
    if (m) {
      pincode = m[1];
      const cleaned = parts[i].replace(m[0], '').replace(/[-–\s]+$/, '').trim();
      if (cleaned) parts[i] = cleaned; else parts.splice(i, 1);
      break;
    }
  }

  const n = parts.length;
  const state = n >= 1 ? parts[n - 1] : '';
  const city  = n >= 2 ? parts[n - 2] : state;
  const addr1 = n >= 3 ? parts.slice(0, n - 2).join(', ') : (parts[0] || '');
  return { addr1: addr1 || city, city, state, pincode };
}

// ── NimbusPost helpers ─────────────────────────────────────────────────────
async function npFetch(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${NP_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  return { ok: res.ok, status: res.status, data };
}

async function npAuthenticate() {
  const email = process.env.NIMBUSPOST_EMAIL;
  const password = process.env.NIMBUSPOST_PASSWORD;
  if (!email || !password) throw new Error('NIMBUSPOST_EMAIL / NIMBUSPOST_PASSWORD env vars not set');

  const { ok, data } = await npFetch('/users/login', {
    method: 'POST',
    body: { email, password },
  });
  const token = data.data || data.token;
  if (!ok || !token) throw new Error(`NimbusPost auth failed: ${JSON.stringify(data)}`);
  return token;
}

// ── Handler ────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };

  const adminKey = process.env.ADMIN_SECRET;
  if (adminKey && event.headers['x-admin-key'] !== adminKey) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { return_request_id, action } = body;
  if (!return_request_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'return_request_id required' }) };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Fetch return request
    const { data: ret, error: retErr } = await supabase
      .from('return_requests')
      .select('*')
      .eq('id', return_request_id)
      .maybeSingle();

    if (retErr) throw retErr;
    if (!ret) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Return request not found' }) };

    // Handle status updates (approve/reject without creating pickup)
    if (action === 'reject') {
      await supabase.from('return_requests').update({ status: 'rejected' }).eq('id', return_request_id);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, status: 'rejected' }) };
    }

    if (action === 'approve') {
      await supabase.from('return_requests').update({ status: 'approved' }).eq('id', return_request_id);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, status: 'approved' }) };
    }

    // Default action: create NimbusPost reverse pickup
    if (ret.status !== 'approved') {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Approve this return before pushing it to NimbusPost.' }) };
    }
    if (ret.awb) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Pickup already created. AWB: ${ret.awb}` }) };
    }

    // Parse customer address (pickup location)
    const { addr1, city, state, pincode } = parseAddress(ret.customer_address || '');
    if (!pincode) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Cannot parse pincode from customer address: "${ret.customer_address}"` }) };
    }

    // Authenticate with NimbusPost Partners API.
    const token = await npAuthenticate();

    // Build items list
    const cartItems = Array.isArray(ret.items) ? ret.items : [];
    const products  = cartItems.length
      ? cartItems.map(i => ({ name: i.title || 'Book', sku: i.sku || '', qty: i.qty || 1, price: i.price || 0 }))
      : [{ name: 'Book', sku: '', qty: 1, price: ret.amount_paise ? Math.round(ret.amount_paise / 100) : 0 }];

    const phone = (ret.customer_phone || '9999999999').replace(/\D/g, '').slice(-10);

    // NimbusPost Partners API reverse shipment. For payment_type=reverse,
    // consignee is the customer pickup address and pickup is our return hub.
    const payload = {
      order_number: `RET-${String(ret.order_display_id || ret.order_id).replace(/^IC-/, '')}`.slice(0, 20),
      payment_type: 'reverse',
      order_amount: ret.amount_paise ? Math.round(ret.amount_paise / 100) : 0,
      package_weight: 300,
      package_length: 20,
      package_height: 3,
      package_breadth: 15,
      request_auto_pickup: 'yes',
      consignee: {
        name: ret.customer_name || 'Customer',
        address: addr1,
        address_2: '',
        city,
        state,
        pincode,
        phone,
      },
      pickup: {
        warehouse_name: process.env.NIMBUSPOST_WAREHOUSE_NAME || 'Office',
        name: RETURN_ADDRESS.name,
        address: RETURN_ADDRESS.address,
        address_2: '',
        city: RETURN_ADDRESS.city,
        state: RETURN_ADDRESS.state,
        pincode: RETURN_ADDRESS.pincode,
        phone: process.env.RETURN_PHONE || process.env.BUSINESS_PHONE || RETURN_ADDRESS.phone,
      },
      order_items: products,
      tags: `return, ${String(ret.reason || 'customer return').slice(0, 150)}`,
    };

    const { ok, data: npData } = await npFetch('/shipments', {
      method: 'POST',
      token,
      body: payload,
    });

    const shipment = npData.data && typeof npData.data === 'object' ? npData.data : npData;
    const awb = shipment.awb_number || shipment.awb || shipment.tracking_number;
    if (!ok || !awb) {
      throw new Error(`NimbusPost reverse pickup failed: ${JSON.stringify(npData)}`);
    }

    const courierName = shipment.courier_name || 'NimbusPost';

    // Update return_request in Supabase
    await supabase.from('return_requests').update({
      status:       'pickup_scheduled',
      awb,
      courier_name: courierName,
      processed_at: new Date().toISOString(),
    }).eq('id', return_request_id);

    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      success: true,
      awb,
      courier_name: courierName,
      pickup_from:  `${ret.customer_name} — ${ret.customer_address}`,
      pickup_to:    '2969, Kucha Mai Dass, Sitaram Bazar, Delhi - 110006',
    }) };

  } catch (err) {
    console.error('process-return error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
