function paymentMeta(order) {
  const items = Array.isArray(order?.cart_items) ? order.cart_items : [];
  for (const item of items) {
    if (item?._payment) return item._payment;
    if (item?.__payment) return item.__payment;
  }
  return {};
}

// Fail closed: only return true when the order is definitely pure COD.
// Partial COD has money captured online, so it is deliberately excluded.
function isDefinitelyCod(order) {
  const persisted = String(order?.shipment_payment_type || '').toLowerCase();
  if (persisted === 'cod') return true;
  if (persisted === 'prepaid' || persisted === 'partial_cod') return false;

  const meta = paymentMeta(order);
  const mode = String(meta.mode || meta.payment_type || '').toLowerCase();
  if (mode === 'partial_cod' || mode === 'prepaid' || mode === 'online') return false;
  if (mode === 'cod') return true;

  const status = String(order?.status || '').toLowerCase();
  if (status === 'partial_cod_pending') return false;
  if (['cod_pending', 'cod_awaiting_confirmation'].includes(status)) return true;
  if (order?.payment_status) return false;
  if (String(order?.razorpay_payment_id || '').trim()) return false;

  // Legacy AWB rows lost their original cod_pending status when AWB assignment
  // changed them to shipped. No payment id + no payment marker is the only
  // safe legacy signature for a pure COD shipment.
  return status === 'shipped';
}

module.exports = { isDefinitelyCod };

