'use strict';

/**
 * Why the store cancelled an order, picked by the admin when cancelling by
 * hand. The code decides which email and WhatsApp the customer gets
 * (utils/order-cancelled-notification.js); the label is what lands in
 * orders.cancellation_reason and the owner email.
 *
 * Before this every admin cancellation told the customer the book was out of
 * stock -- including orders cancelled because the address was incomplete or
 * no courier delivers to the pincode, where "please order again" without
 * fixing the address just fails a second time.
 */

const CANCEL_REASONS = {
  out_of_stock:          { label: 'No inventory / out of stock',  kind: 'store' },
  incomplete_address:    { label: 'Incomplete or wrong address', kind: 'address' },
  unserviceable_pincode: { label: 'Pincode not serviceable',      kind: 'pincode' },
  customer_request:      { label: 'Customer asked to cancel',     kind: 'customer' },
  other:                 { label: 'Other',                        kind: 'other', needsNote: true },
};

const flat = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

// What people actually type in a CSV column.
const ALIASES = {
  no_inventory: 'out_of_stock', out_of_stock: 'out_of_stock', stock: 'out_of_stock', no_stock: 'out_of_stock',
  address: 'incomplete_address', incomplete_address: 'incomplete_address', wrong_address: 'incomplete_address',
  pincode: 'unserviceable_pincode', not_serviceable: 'unserviceable_pincode', unserviceable: 'unserviceable_pincode',
  pincode_not_serviceable: 'unserviceable_pincode', non_serviceable_pincode: 'unserviceable_pincode',
  customer: 'customer_request', customer_request: 'customer_request', customer_asked: 'customer_request',
};

/**
 * @returns {{ code, label, kind, note }} | { error } | null when no code given
 */
function readCancelReason(code, note) {
  const raw = String(code || '').trim().toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '');
  if (!raw) return null;
  const c = CANCEL_REASONS[raw] ? raw : (ALIASES[raw] || raw);
  const r = CANCEL_REASONS[c];
  if (!r) return { error: `Unknown cancel_reason "${c}". Use one of: ${Object.keys(CANCEL_REASONS).join(', ')}` };
  const n = flat(note, 300);
  if (r.needsNote && !n) return { error: 'cancel_reason "other" needs a cancel_note: the customer is shown it.' };
  return { code: c, label: r.label, kind: r.kind, note: n };
}

/** The delivery pincode: addresses end with it ("..., Pune, Maharashtra 411001"). */
function pincodeOf(order) {
  const all = String(order && order.customer_address || '').match(/\b[1-9]\d{5}\b/g);
  return all ? all[all.length - 1] : '';
}

module.exports = { CANCEL_REASONS, readCancelReason, pincodeOf };
