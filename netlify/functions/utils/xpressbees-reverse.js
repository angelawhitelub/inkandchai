'use strict';

/**
 * Book an XpressBees reverse pickup for an approved return request.
 *
 * The Returns tab could only book reverse pickups through NimbusPost, whose
 * serviceability often offers no reverse-capable courier for a pincode. This
 * books straight with XpressBees ("Express Reverse", POST /api/ReverseShipments)
 * from the customer's address to our warehouse, with auto-pickup requested.
 *
 * `categories` is required and the doc's list of valid values is cut off, so
 * the candidates are tried in order -- but ONLY past a category rejection. A
 * validation failure books nothing, so moving on is safe; any other failure
 * stops at once, because it may not be one. XPRESSBEES_REVERSE_CATEGORY pins
 * the value once the right one is known.
 */

const xb = require('./xpressbees');

const CATEGORY_CANDIDATES = ['Books', 'Books & Stationery', 'Stationery', 'Others', 'Other'];

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const digits10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);

/** "IC-20260902-J8RS4" → "R-20260902-J8RS4" (XpressBees allows 20 chars). */
function reverseOrderId(ret) {
  return `R-${String(ret.order_display_id || ret.order_id || ret.id).replace(/^IC-/i, '')}`.slice(0, 20);
}

function buildReversePayload(ret, addr, category) {
  const items = Array.isArray(ret.items) ? ret.items : [];
  const titles = items.map(i => clip(i && (i.title || i.name), 120)).filter(Boolean);
  const qty = items.reduce((n, i) => n + (Number(i && i.qty) || 1), 0) || 1;
  const amountRs = ret.amount_paise ? Math.round(Number(ret.amount_paise) / 100) : 0;
  const pickup = xb.pickupFromEnv();
  return {
    order_id: reverseOrderId(ret),
    request_auto_pickup: 'yes',
    consignee: {
      name: clip(ret.customer_name || 'Customer', 200),
      address: clip(addr.addr1, 200),
      address_2: '',
      city: clip(addr.city, 40),
      state: clip(addr.state, 40),
      pincode: String(addr.pincode),
      phone: digits10(ret.customer_phone) || pickup.phone,
    },
    pickup: { ...pickup, warehouse_name: clip(pickup.warehouse_name, 20) },
    categories: category,
    product_name: clip(titles.join(', ') || 'Books', 200),
    product_qty: String(qty),
    product_amount: String(amountRs),
    package_weight: 400,
    package_length: '20',
    package_breadth: '15',
    package_height: '5',
    qccheck: '0',
    uploadedimage: '',
    uploadedimage_2: '',
    uploadedimage_3: '',
    uploadedimage_4: '',
    product_usage: '0',
    product_damage: '0',
    brandname: '0',
    productsize: '0',
    productcolor: '0',
  };
}

/**
 * @returns {{ shipment: object, category: string, tried: string[] }}
 * @throws the XpressBees error when it is not a category rejection, or the
 *         last one when every candidate was rejected.
 */
async function bookReverseForReturn(ret, addr, deps = {}) {
  const book = deps.bookReverse || xb.bookReverse;
  const pinned = String(process.env.XPRESSBEES_REVERSE_CATEGORY || '').trim();
  const candidates = pinned ? [pinned] : CATEGORY_CANDIDATES;
  const tried = [];
  let lastErr = null;
  for (const category of candidates) {
    tried.push(category);
    try {
      const shipment = await book(buildReversePayload(ret, addr, category));
      return { shipment, category, tried };
    } catch (e) {
      lastErr = e;
      if (!/categor/i.test(String(e.message || ''))) throw e;
    }
  }
  const err = new Error(`${lastErr ? lastErr.message : 'rejected'} (categories tried: ${tried.join(', ')} — set XPRESSBEES_REVERSE_CATEGORY to the right one)`);
  throw err;
}

module.exports = { buildReversePayload, bookReverseForReturn, reverseOrderId, CATEGORY_CANDIDATES };
