/**
 * Shiprocket API utility
 * Auto-pushes orders to Shiprocket panel when placed on inkandchai.in.
 *
 * Required Netlify env vars:
 *   SHIPROCKET_EMAIL           — API user email (Settings → API in Shiprocket)
 *   SHIPROCKET_PASSWORD        — API user password
 *   SHIPROCKET_PICKUP_LOCATION — warehouse name exactly as in Shiprocket (e.g. "Office")
 *
 * Optional:
 *   SHIPROCKET_CHANNEL_ID      — channel ID from the Manual channel you created (leave blank to omit)
 */

const BASE = 'https://apiv2.shiprocket.in/v1/external';

// ── Authenticate and get Bearer token ────────────────────────────────────────
async function getToken() {
  const email    = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;
  if (!email || !password) throw new Error('SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD not set in Netlify env vars');

  const res  = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok || !data.token) throw new Error(`Shiprocket auth failed: ${JSON.stringify(data)}`);
  return data.token;
}

// ── Parse customer_address string into components ─────────────────────────────
// Our address is stored as one string: "12B, MG Road, Lajpat Nagar, New Delhi, 110024, Delhi"
function parseAddress(addressStr) {
  if (!addressStr) return {};
  // Common format from checkout: "house/street, city, pincode, state"
  // Try to extract pincode (6 digits)
  const pincodeMatch = addressStr.match(/\b(\d{6})\b/);
  const pincode = pincodeMatch ? pincodeMatch[1] : '';

  // Remove pincode from string, split remaining
  const withoutPin = addressStr.replace(pincode, '').replace(/,\s*,/g, ',').trim().replace(/,\s*$/, '');
  const parts = withoutPin.split(',').map(p => p.trim()).filter(Boolean);

  // Heuristic: last part = state, second-to-last = city, rest = address line
  const state   = parts[parts.length - 1] || '';
  const city    = parts[parts.length - 2] || '';
  const address = parts.slice(0, -2).join(', ');

  return { address: address || withoutPin, city, state, pincode };
}

// ── Estimate weight/dimensions from cart ─────────────────────────────────────
function estimateDims(items) {
  const qty = items.reduce((s, i) => s + (i.qty || 1), 0);
  // Approx: each book ≈ 250g, 22x14x3 cm
  return {
    weight: Math.max(0.5, qty * 0.25),          // kg
    length: 22,
    breadth: 14,
    height: Math.max(3, qty * 3),               // cm stacked
  };
}

// ── Push one order to Shiprocket ──────────────────────────────────────────────
async function pushOrderToShiprocket({ inkOrderId, customerName, customerEmail, customerPhone, customerAddress, cartItems, amountPaise, status, createdAt }) {
  const token = await getToken();

  const isCOD     = ['cod_pending', 'partial_cod_pending'].includes(status);
  const payMethod = isCOD ? 'COD' : 'Prepaid';
  const amountRs  = (amountPaise || 0) / 100;
  const items     = Array.isArray(cartItems) ? cartItems : [];
  const subtotal  = items.reduce((s, i) => s + (i.price * (i.qty || 1)), 0) || amountRs;
  const dims      = estimateDims(items);

  const addr = parseAddress(customerAddress);
  const orderDate = createdAt
    ? new Date(createdAt).toISOString().slice(0, 10)   // YYYY-MM-DD
    : new Date().toISOString().slice(0, 10);

  const pickupLocation = process.env.SHIPROCKET_PICKUP_LOCATION || 'Office';
  const channelId      = process.env.SHIPROCKET_CHANNEL_ID ? parseInt(process.env.SHIPROCKET_CHANNEL_ID) : undefined;

  const payload = {
    order_id:             inkOrderId,
    order_date:           orderDate,
    pickup_location:      pickupLocation,

    // Billing = Shipping (same address)
    billing_customer_name:  customerName || 'Customer',
    billing_last_name:       '',
    billing_address:         addr.address || customerAddress || '',
    billing_address_2:       '',
    billing_city:            addr.city || '',
    billing_pincode:         addr.pincode || '',
    billing_state:           addr.state || '',
    billing_country:         'India',
    billing_email:           customerEmail || '',
    billing_phone:           (customerPhone || '').replace(/\D/g, '').slice(-10),
    shipping_is_billing:     true,

    // Items
    order_items: items.length > 0
      ? items.map(i => ({
          name:          (i.title || i.name || 'Book').slice(0, 80),
          sku:           i.sku || i.slug || `BOOK-${inkOrderId}`,
          units:         i.qty || 1,
          selling_price: i.price || 0,
          hsn:           '',
        }))
      : [{
          name:          'Books',
          sku:           `BOOK-${inkOrderId}`,
          units:         1,
          selling_price: amountRs,
          hsn:           '',
        }],

    payment_method: payMethod,
    sub_total:      subtotal,
    length:         dims.length,
    breadth:        dims.breadth,
    height:         dims.height,
    weight:         dims.weight,
  };

  if (channelId) payload.channel_id = channelId;

  const res  = await fetch(`${BASE}/orders/create/adhoc`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Shiprocket order creation failed: ${JSON.stringify(data)}`);

  console.log(`[Shiprocket] ✅ Order ${inkOrderId} pushed → Shiprocket order_id: ${data.order_id}`);
  return data;
}

module.exports = { pushOrderToShiprocket };
