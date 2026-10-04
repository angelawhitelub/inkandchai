/**
 * The Not Picked Up list, built once for the admin tab (admin-not-picked-up)
 * and the daily report (not-picked-up-report-scheduled) so they never disagree.
 * Read-only.
 */
const { classify, summarize, withOriginal, UNBOOKED } = require('./not-picked-up');
const { isReplacementOrder, replacementMeta, isMissingBookReplacement } = require('./missing-books');

const COLUMNS = [
  'id', 'razorpay_order_id', 'status', 'created_at', 'customer_name', 'customer_phone', 'customer_address',
  'amount_paise', 'advance_paid_paise', 'razorpay_payment_id', 'payment_status', 'shipment_payment_type',
  'source', 'cart_items', 'tracking_id', 'tracking_url', 'courier_name', 'shipped_at', 'awb_assigned_at',
  'shipment_moved_at', 'last_courier_status', 'last_courier_status_at', 'last_nimbuspost_status',
  'nimbus_pushed_at', 'ithink_pushed_at',
];
const PAGE = 1000;

// Some of these columns arrive by migration. A missing one fails the whole
// PostgREST query, so drop it and retry instead of taking the tab down.
async function loadOrders(db, sinceIso, untilIso) {
  let cols = [...COLUMNS];
  for (let attempt = 0; attempt < 6; attempt++) {
    const rows = [];
    let failed = null;
    for (let from = 0; from < 20 * PAGE; from += PAGE) {
      const { data, error } = await db.from('orders')
        .select(cols.join(','))
        .in('status', ['shipped', ...UNBOOKED])
        .gte('created_at', sinceIso)
        .lte('created_at', untilIso)
        .order('created_at', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) { failed = error; break; }
      rows.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    if (!failed) return rows;
    const missing = String(failed.message || '').match(/column orders\.(\w+) does not exist|column "?(\w+)"? does not exist/);
    const col = missing && (missing[1] || missing[2]);
    if (!col || !cols.includes(col) || ['id', 'status', 'created_at', 'tracking_id'].includes(col)) throw new Error(failed.message);
    console.warn(`[not-picked-up-list] orders.${col} missing — continuing without it`);
    cols = cols.filter((c) => c !== col);
  }
  throw new Error('too many missing columns');
}

// A replacement's refund depends on how its ORIGINAL order was paid, and a COD
// customer's UPI ID may sit on the original (the missing-book form stamps it
// there), so the originals are read too. A replacement can replace another
// replacement; the chain is followed back to the order the customer paid for.
const ORIGINAL_COLS = 'razorpay_order_id, razorpay_payment_id, status, source, cart_items';

async function loadByOrderId(db, ids, into) {
  const want = [...new Set(ids)].filter((id) => id && !into.has(id));
  for (let i = 0; i < want.length; i += 200) {
    const { data, error } = await db.from('orders').select(ORIGINAL_COLS).in('razorpay_order_id', want.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const o of data || []) into.set(o.razorpay_order_id, o);
  }
}

async function loadOriginals(db, rows) {
  const byId = new Map();
  let next = rows.map((r) => r.replacement && r.replacement.original_order_id);
  for (let hop = 0; hop < 4 && next.some(Boolean); hop++) {
    await loadByOrderId(db, next, byId);
    next = next.map((id) => {
      const o = id && byId.get(id);
      const m = o && isReplacementOrder(o) && replacementMeta(o);
      return m ? m.original_order_id : null;
    });
  }
  // Direct original (for the UPI from the report) and the paid root (for how it was paid).
  return (id) => {
    const direct = byId.get(id) || null;
    let root = direct;
    const via = [];
    for (let hop = 0; root && isReplacementOrder(root) && hop < 4; hop++) {
      const up = (replacementMeta(root) || {}).original_order_id;
      via.push(root.razorpay_order_id);
      root = up ? byId.get(up) || null : null;
    }
    return { direct, root, via };
  };
}

/**
 * { orders, rows, counts }. `orders` are the raw rows (for a live courier
 * check), `rows` what the tab shows.
 */
async function listNotPicked(db, { minHours, days = 30, now = Date.now() }) {
  const orders = await loadOrders(db,
    new Date(now - days * 24 * 3600 * 1000).toISOString(),
    new Date(now - minHours * 3600 * 1000).toISOString());
  const listed = orders.map((o) => [o, classify(o, now, minHours)]).filter(([, r]) => r);
  const originalOf = await loadOriginals(db, listed.map(([, r]) => r));
  const rows = listed.map(([o, r]) => {
    if (!r.replacement) return r;
    const chain = originalOf(r.replacement.original_order_id);
    const row = withOriginal(r, chain);
    // Same test the refund flows use: the reason, or a title the customer
    // reported missing on the original.
    row.replacement.missing_book = isMissingBookReplacement(o, chain.direct);
    return row;
  });
  return { orders: listed.map(([o]) => o), rows, counts: summarize(rows) };
}

module.exports = { listNotPicked };
