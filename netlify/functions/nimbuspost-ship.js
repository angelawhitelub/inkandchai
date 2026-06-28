/**
 * Netlify Function: nimbuspost-ship
 * POST /.netlify/functions/nimbuspost-ship
 *
 * Creates a NimbusPost shipment for one or more website orders.
 * Fetches order from Supabase → authenticates with NimbusPost →
 * checks serviceability → creates shipment → stores AWB back in order.
 *
 * Required env vars (set in Netlify → Site Settings → Environment Variables):
 *   NIMBUSPOST_API_KEY        your NimbusPost API key
 *                             → ship.nimbuspost.com → Settings → API → Reset API Key
 *   NIMBUSPOST_EMAIL          your NimbusPost login email
 *   NIMBUSPOST_PASSWORD       your NimbusPost login password
 *   NIMBUSPOST_WAREHOUSE_ID   warehouse ID from NimbusPost → Settings → Warehouses
 *                             (leave blank to auto-fetch first warehouse)
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   ADMIN_SECRET
 *
 * Body (single order):  { order_id: "IC-20260527-U5F5V" }
 * Body (bulk):          { order_ids: ["IC-...", "IC-..."] }
 * Body (get couriers):  { order_id: "IC-...", action: "serviceability" }
 *   ↑ use this to preview couriers + rates before committing
 *
 * Optional overrides per request:
 *   courier_id  (int)   — force a specific NimbusPost courier ID
 */

const { createClient } = require('@supabase/supabase-js');
const { sanitizeForCourier } = require('./utils/nimbuspost-import');
const { requireAdmin } = require('./utils/admin-auth');

const NP_BASE = 'https://api.nimbuspost.com/v1';

// ── Courier name → Delhivery-style tracking URL ────────────────────────────
const COURIER_TRACK_URLS = {
  delhivery:    'https://www.delhivery.com/track-v2/package/{awb}',
  bluedart:     'https://www.bluedart.com/tracking?trackingNumber={awb}',
  dtdc:         'https://www.dtdc.in/tracking/tracking_results.asp?action=track&Type=awb&strCnno={awb}',
  xpressbees:   'https://www.xpressbees.com/track?awbNo={awb}',
  shadowfax:    'https://shadowfax.in/tracking/?awb={awb}',
  ecomexpress:  'https://ecomexpress.in/tracking/?awb_field={awb}',
};

function courierTrackUrl(name, awb) {
  const key = (name || '').toLowerCase().replace(/[^a-z]/g, '');
  const nimbusUrl = `https://ship.nimbuspost.com/shipping/tracking/${encodeURIComponent(awb)}`;
  if (key.includes('ekart') || key.includes('nimbus')) return nimbusUrl;
  const tpl = Object.entries(COURIER_TRACK_URLS).find(([k]) => key.includes(k))?.[1];
  return tpl ? tpl.replace('{awb}', encodeURIComponent(awb)) : nimbusUrl;
}

// ── Address parser (single string → fields) ────────────────────────────────
// Input:  "Flat 12, Gokhale Rd, Dadar, Mumbai, Maharashtra - 400028"
// Output: { addr1, addr2, city, state, pincode }
function parseAddress(addr) {
  if (!addr) return { addr1: '', addr2: '', city: '', state: '', pincode: '' };
  const parts = addr.split(',').map(p => p.trim()).filter(Boolean);

  // Extract 6-digit pincode (may be appended with dash/space)
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
  const addr1 = n >= 3 ? parts.slice(0, n - 2).join(', ') : (n === 2 ? parts[0] : '');
  return { addr1: addr1 || city, addr2: '', city, state, pincode };
}

// Flat 400g / 15×10×5 for every shipment regardless of qty or product mix.
function estimateDims(_cartItems) {
  return { weight: 400, length: 15, breadth: 10, height: 5 };
}

// ── NimbusPost API helpers ─────────────────────────────────────────────────
// NimbusPost Partners API — POST /v1/users/login → Authorization: Bearer {token}
// (Old x-api-key + NP-API-SECRET format is no longer accepted by NimbusPost)
async function npFetch(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
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
  const email    = process.env.NIMBUSPOST_EMAIL;
  const password = process.env.NIMBUSPOST_PASSWORD;
  if (!email || !password) throw new Error('NIMBUSPOST_EMAIL / NIMBUSPOST_PASSWORD env vars not set');

  const { ok, data } = await npFetch('/users/login', {
    method: 'POST',
    body: { email, password },
  });
  // Response: { status: true, data: "JWT_TOKEN_STRING" }
  const token = data.data || data.token;
  if (!ok || !token) throw new Error(`NimbusPost login failed: ${JSON.stringify(data)}`);
  return token;
}

async function npGetWarehouses(token) {
  // Try Partners API endpoint first
  const r1 = await npFetch('/client/warehouses', { token });
  if (r1.ok) return Array.isArray(r1.data?.data) ? r1.data.data : (Array.isArray(r1.data) ? r1.data : []);

  // Fallback: some accounts use /warehouses
  const r2 = await npFetch('/warehouses', { token });
  if (r2.ok) return Array.isArray(r2.data?.data) ? r2.data.data : (Array.isArray(r2.data) ? r2.data : []);

  throw new Error(
    `NimbusPost warehouses API not accessible (${r1.status}). ` +
    `Fix: In Netlify env vars, set NIMBUSPOST_WAREHOUSE_ID to your warehouse ID ` +
    `(find it at ship.nimbuspost.com → Settings → Warehouses). ` +
    `This will skip the warehouse API call entirely. ` +
    `Raw error: ${JSON.stringify(r1.data).slice(0, 200)}`
  );
}

async function npServiceability(token, { destination_pincode, weight, is_cod }) {
  const { ok, data } = await npFetch('/courier/serviceability', {
    method: 'POST',
    token,
    body: {
      destination_pincode: String(destination_pincode),
      weight: Number(weight) || 300,
      cod: is_cod ? 1 : 0,
      mode: 'surface',
    },
  });
  if (!ok) throw new Error(`NimbusPost serviceability failed: ${JSON.stringify(data)}`);
  // Returns array of couriers with id, name, rate
  return Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
}

async function npCreateShipment(token, payload) {
  const { ok, data } = await npFetch('/shipments', {
    method: 'POST',
    token,
    body: payload,
  });
  if (!ok || !data.awb_number) {
    throw new Error(`NimbusPost shipment creation failed: ${JSON.stringify(data)}`);
  }
  return { awb: data.awb_number, courier_name: data.courier_name || payload.courier_name || '' };
}

// ── Core: ship a single order ──────────────────────────────────────────────
async function shipOrder(supabase, token, warehouseId, order, forceCourierId) {
  const orderId = order.razorpay_order_id || order.id;
  const { addr1, addr2, city, state, pincode } = parseAddress(order.customer_address || '');

  if (!pincode) throw new Error(`Cannot determine pincode for order ${orderId}`);

  const { weight, length, height, breadth } = estimateDims(order.cart_items);
  const amountRs = order.amount_paise ? Math.round(order.amount_paise / 100) : 0;

  const isCOD = ['cod_pending', 'partial_cod_pending'].includes(order.status);
  const collectableAmount = isCOD ? amountRs : 0;

  // ── Serviceability → pick courier ────────────────────────────────────────
  let courierId   = forceCourierId;
  let courierName = '';

  if (!courierId) {
    const couriers = await npServiceability(token, {
      destination_pincode: pincode,
      weight,
      is_cod: isCOD,
    });
    if (!couriers.length) throw new Error(`No couriers serviceable for pincode ${pincode}`);

    // Pick cheapest available courier
    const sorted = couriers
      .filter(c => c.is_active !== false && c.is_available !== false)
      .sort((a, b) => (Number(a.total_charges) || 0) - (Number(b.total_charges) || 0));

    const best = sorted[0] || couriers[0];
    courierId   = best.id || best.courier_id;
    courierName = best.name || best.courier_name || '';
  }

  // ── Build products list ──────────────────────────────────────────────────
  const cartItems = Array.isArray(order.cart_items) ? order.cart_items : [];
  const products  = cartItems.length
    ? cartItems.map(i => ({
        product_name: sanitizeForCourier(i.title || i.name || 'Book'),
        sku:          i.sku   || '',
        qty:          i.qty   || 1,
        unit_price:   i.price || 0,
      }))
    : [{ product_name: 'Books', sku: '', qty: 1, unit_price: amountRs }];

  // ── Create shipment ──────────────────────────────────────────────────────
  const payload = {
    order_number:          orderId,
    payment_type:          isCOD ? 'cod' : 'prepaid',
    order_amount:          amountRs,
    collectable_amount:    collectableAmount,
    weight,
    length,
    height,
    breadth,
    courier_id:            courierId,
    consignee_name:        order.customer_name  || '',
    consignee_address:     addr1,
    consignee_address_2:   addr2,
    consignee_city:        city,
    consignee_state:       state,
    consignee_pincode:     pincode,
    consignee_phone:       (order.customer_phone || '').replace(/\D/g, '').slice(-10),
    warehouse_id:          warehouseId,
    products,
  };

  const { awb, courier_name } = await npCreateShipment(token, payload);
  const trackingUrl = courierTrackUrl(courier_name || courierName, awb);

  // ── Update Supabase order ────────────────────────────────────────────────
  const { error: updErr } = await supabase.from('orders').update({
    status:       'shipped',
    tracking_id:  awb,
    courier_name: courier_name || courierName || 'NimbusPost',
    tracking_url: trackingUrl,
    shipped_at:   new Date().toISOString(),
  }).eq('id', order.id);

  if (updErr) console.warn('Supabase update warning:', updErr.message);

  return { order_id: orderId, awb, courier_name: courier_name || courierName, tracking_url: trackingUrl };
}

// ── CORS / auth helpers ───────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

function json(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

// ── Handler ───────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST')    return json(405, { error: 'Method not allowed' });

  // Fail closed via centralised gate (signed token preferred, legacy key OK).
  // Anyone hitting this can push real shipments and burn courier credits.
  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const { order_id, order_ids, action, courier_id: forceCourierId } = body;
  const ids = order_ids || (order_id ? [order_id] : []);
  if (!ids.length) return json(400, { error: 'Provide order_id or order_ids' });

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // ── Fetch orders from Supabase ──────────────────────────────────────
    const { data: orders, error: fetchErr } = await supabase
      .from('orders')
      .select('*')
      .in('razorpay_order_id', ids);

    if (fetchErr) throw fetchErr;
    if (!orders?.length) return json(404, { error: 'No orders found for given IDs' });

    // ── Authenticate with NimbusPost ────────────────────────────────────
    const token = await npAuthenticate();

    // ── Resolve warehouse ───────────────────────────────────────────────
    let warehouseId = process.env.NIMBUSPOST_WAREHOUSE_ID
      ? parseInt(process.env.NIMBUSPOST_WAREHOUSE_ID, 10)
      : null;

    if (!warehouseId) {
      const warehouses = await npGetWarehouses(token);
      if (!warehouses.length) throw new Error('No warehouses found in NimbusPost. Please add one at ship.nimbuspost.com → Settings → Warehouses.');
      warehouseId = warehouses[0].id || warehouses[0].warehouse_id;
      console.log(`Auto-selected warehouse: ${warehouseId} (${warehouses[0].name || ''})`);
    }

    // ── Serviceability preview (no shipment creation) ───────────────────
    if (action === 'serviceability') {
      const order  = orders[0];
      const { pincode } = parseAddress(order.customer_address || '');
      const { weight }  = estimateDims(order.cart_items);
      const isCOD = ['cod_pending', 'partial_cod_pending'].includes(order.status);

      const couriers = await npServiceability(token, { destination_pincode: pincode, weight, is_cod: isCOD });
      return json(200, {
        pincode,
        weight_g: weight,
        is_cod: isCOD,
        couriers: couriers.map(c => ({
          id:           c.id || c.courier_id,
          name:         c.name || c.courier_name,
          rate:         c.total_charges || c.rate,
          estimated_delivery: c.estimated_delivery || c.etd,
        })),
      });
    }

    // ── Create shipments ────────────────────────────────────────────────
    const results  = [];
    const failures = [];

    for (const order of orders) {
      // Skip already-shipped orders
      if (order.tracking_id) {
        results.push({ order_id: order.razorpay_order_id || order.id, skipped: true, reason: 'Already has tracking: ' + order.tracking_id });
        continue;
      }
      try {
        const result = await shipOrder(supabase, token, warehouseId, order, forceCourierId);
        results.push(result);
      } catch (err) {
        console.error(`Failed to ship order ${order.razorpay_order_id || order.id}:`, err.message);
        failures.push({ order_id: order.razorpay_order_id || order.id, error: err.message });
      }
    }

    return json(200, {
      shipped:  results.filter(r => !r.skipped),
      skipped:  results.filter(r =>  r.skipped),
      failures,
    });

  } catch (err) {
    console.error('nimbuspost-ship error:', err);
    return json(500, { error: err.message });
  }
};
