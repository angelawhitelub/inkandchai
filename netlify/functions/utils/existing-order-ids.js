'use strict';

/**
 * Which of these order ids the database already has, in batches.
 * → { ids: Set } or { error } -- an unreadable database must not look like
 * "every order is missing", which would try to re-insert all of them.
 */
async function existingOrderIds(supabase, orderIds, batch = 200) {
  const ids = new Set();
  const unique = [...new Set(orderIds.filter(Boolean).map(String))];
  for (let i = 0; i < unique.length; i += batch) {
    const { data, error } = await supabase
      .from('orders').select('razorpay_order_id').in('razorpay_order_id', unique.slice(i, i + batch));
    if (error) return { error: error.message };
    for (const r of data || []) ids.add(r.razorpay_order_id);
  }
  return { ids };
}

module.exports = { existingOrderIds };
