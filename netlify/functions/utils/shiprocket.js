/**
 * Shiprocket API utility
 * Auto-pushes orders to Shiprocket panel when placed on inkandchai.in.
 *
 * Required Netlify env vars:
 *   SHIPROCKET_EMAIL           — API user email (Settings → API in Shiprocket)
 *   SHIPROCKET_PASSWORD        — API user password
 *   SHIPROCKET_PICKUP_LOCATION — the pickup address NICKNAME exactly as Shiprocket shows it
 *                                under Settings -> Pickup Addresses. Ours is "Home". This is
 *                                an exact string match: "home" or a trailing space is rejected,
 *                                and the fallback below ('Office') matches nothing in our account,
 *                                so leaving this unset fails every order at creation.
 *
 * Optional:
 *   SHIPROCKET_CHANNEL_ID      — channel ID from the Manual channel you created (leave blank to omit)
 */

const { createClient } = require('@supabase/supabase-js');
const { classifyShipmentMoney } = require('./shipment-money');
const { isReplacementOrder } = require('./replacement-order');

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
// Callers pass either an `orders` row or the older flat argument bag. Both are
// accepted because three of the four call sites are live checkout paths --
// cod-order, verify-payment, phonepe-verify-status -- and none of them should
// have to change to get the money right.
function asOrderRow(input) {
  if (!input || typeof input !== 'object') return {};
  if (!('inkOrderId' in input)) return input;          // already a row
  return {
    razorpay_order_id:   input.inkOrderId,
    razorpay_payment_id: input.razorpayPaymentId || null,
    status:              input.status,
    amount_paise:        input.amountPaise,
    advance_paid_paise:  input.advancePaidPaise || 0,
    cart_items:          input.cartItems,
    customer_name:       input.customerName,
    customer_email:      input.customerEmail,
    customer_phone:      input.customerPhone,
    customer_address:    input.customerAddress,
    created_at:          input.createdAt,
  };
}

async function pushOrderToShiprocket(input) {
  const order = asOrderRow(input);
  const inkOrderId      = order.razorpay_order_id;
  const customerName    = order.customer_name;
  const customerEmail   = order.customer_email;
  const customerPhone   = order.customer_phone;
  const customerAddress = order.customer_address;
  const createdAt       = order.created_at;

  // What the courier is allowed to ask for at the door, decided by WHAT IS
  // STILL OWED rather than by the status label.
  //
  // The old test here was `['cod_pending','partial_cod_pending'].includes(status)`
  // with sub_total taken from the cart lines. Both halves were wrong, and a
  // dry run over 46 live orders showed exactly how:
  //
  //   * cart lines exclude delivery, so 27 COD parcels would have collected the
  //     book price and not the shipping -- Rs 1,063 never asked for;
  //   * on partial COD, amount_paise is the DEPOSIT, while the cart still holds
  //     the full basket, so 2 customers who had already paid Rs 55 online would
  //     have been asked for the whole Rs 549 again at their door.
  //
  // classifyShipmentMoney is the one place that gets this right, it is what
  // iThink and NimbusPost already use, and it fails closed: a partial-COD order
  // with no balance metadata throws rather than guessing. Shiprocket's adhoc
  // endpoint has no separate collectable field -- for COD it collects sub_total
  // -- so sub_total IS the collectable and must be that number exactly. On a
  // partial-COD order that deliberately makes sub_total smaller than the sum of
  // the item lines; the difference is the deposit the customer already paid.
  const money     = classifyShipmentMoney(order, isReplacementOrder(order));
  const payMethod = money.isCOD ? 'COD' : 'Prepaid';
  const subtotal  = money.isCOD ? money.collectableAmount : money.orderValueRs;

  const token = await getToken();
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const dims  = estimateDims(items);
  const amountRs = subtotal;

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

  console.log(`[Shiprocket] ✅ Order ${inkOrderId} pushed → Shiprocket order_id: ${data.order_id}, shipment_id: ${data.shipment_id}`);

  // Save Shiprocket IDs back to our DB so the webhook can match orders reliably
  if ((data.order_id || data.shipment_id) && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      // shiprocket_shipment_id is NOT written: the column does not exist on
      // `orders`, and PostgREST rejects the whole statement over one unknown
      // column -- which silently took shiprocket_order_id down with it, so
      // nothing was ever saved and order-tracking.js (which matches on
      // shiprocket_order_id) could never find the order a webhook was about.
      const update = {};
      if (data.order_id) update.shiprocket_order_id = String(data.order_id);
      await supabase.from('orders').update(update).eq('razorpay_order_id', inkOrderId);
      console.log(`[Shiprocket] Saved SR IDs for ${inkOrderId}:`, update);
    } catch (e) {
      console.error('[Shiprocket] Failed to save SR IDs (non-fatal):', e.message);
    }
  }

  return data;
}

module.exports = { pushOrderToShiprocket };
