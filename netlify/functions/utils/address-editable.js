/**
 * Single source of truth for "can the customer still edit their delivery
 * address?" — used by track-order (to show the option) and update-order-address
 * (to enforce it). A customer may change the address exactly ONCE, and only
 * while the order hasn't been handed to a courier yet.
 *
 * Editable only when ALL are true:
 *   • no AWB/tracking assigned yet (tracking_id empty)   → not handed to courier
 *   • not marked shipped (shipped_at empty)
 *   • status isn't shipped / in-transit / delivered / terminal
 *   • the customer hasn't already updated it once (address_updated_by_customer_at)
 */

// Statuses at/after handoff — address can no longer change.
const LOCKED_STATUSES = new Set([
  'shipped', 'in_transit', 'out_for_delivery', 'delivered',
  'rto', 'undelivered', 'lost', 'cancelled', 'refunded',
]);

function canEditAddress(order) {
  if (!order) return false;
  if (order.tracking_id) return false;                 // AWB assigned → locked
  if (order.shipped_at) return false;                  // marked shipped
  if (LOCKED_STATUSES.has(String(order.status || '').toLowerCase())) return false;
  if (order.address_updated_by_customer_at) return false;   // one-time only
  return true;
}

// Reason the option is unavailable — lets the API return a clear message.
function addressLockReason(order) {
  if (!order) return 'Order not found.';
  if (order.address_updated_by_customer_at) return 'You have already updated the address for this order once.';
  if (order.tracking_id || order.shipped_at || LOCKED_STATUSES.has(String(order.status || '').toLowerCase())) {
    return 'This order has already been shipped, so the address can no longer be changed. Please contact us if it needs to go elsewhere.';
  }
  return 'The address can no longer be changed for this order.';
}

module.exports = { canEditAddress, addressLockReason, LOCKED_STATUSES };
