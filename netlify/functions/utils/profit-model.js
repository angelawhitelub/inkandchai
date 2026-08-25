/**
 * Unit-economics model for the orders table.
 *
 * The numbers are averages the owner supplies — ad spend per order, shipping
 * per parcel, cost per book — so this is an estimate, not accounting. What it
 * has to get right is WHICH orders each cost lands on, because that is where a
 * naive version misleads:
 *
 *  - A cancelled order costs nothing to ship. NimbusPost credits the charge
 *    back to the wallet, so it must not be counted.
 *  - An RTO costs shipping TWICE — out and back — and earns nothing. This is
 *    the single most expensive outcome and the reason a business with healthy
 *    revenue can still lose money.
 *  - A returned or cancelled book is back on the shelf, so its cost is not
 *    lost. Only a parcel that stayed with the customer consumes stock.
 *  - Ad spend is gone the moment the click happened, whatever the order did
 *    afterwards. It is charged to every order, including the cancelled ones.
 *
 * Status alone is not enough to classify an order — a partial-COD order stays
 * `partial_cod_pending` all the way to the door — so the courier's own view and
 * the presence of an AWB are used as evidence too.
 */

const DEFAULT_RATES = {
  adCostPerOrder: 92,     // average Google Ads cost to acquire one order
  shippingPerOrder: 62,   // one-way courier charge
  bookCost: 80,           // average cost of one book to us
};

const BUCKETS = ['delivered', 'in_transit', 'rto', 'cancelled', 'refunded', 'pending'];

const BUCKET_LABELS = {
  delivered: 'Delivered',
  in_transit: 'In transit',
  rto: 'RTO (returned)',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  pending: 'Not yet shipped',
};

const isRefundStatus = (s) => /^refund/.test(s) || s === 'refunded';

/** Which outcome is this order actually in? Evidence first, label second. */
function classify(order) {
  const status = String(order.status || '').toLowerCase();
  const np = String(order.last_nimbuspost_status || '').toLowerCase();
  const hasAwb = !!order.tracking_id;

  if (status === 'cancelled') return 'cancelled';
  // An RTO is an RTO even if the status column has not caught up.
  if (status === 'rto' || np.startsWith('rto')) return 'rto';
  if (isRefundStatus(status)) return 'refunded';
  if (status === 'delivered' || np === 'delivered') return 'delivered';
  if (hasAwb || status === 'shipped' || status === 'out_for_delivery') return 'in_transit';
  return 'pending';
}

function unitsOf(order) {
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const n = items.reduce((sum, i) => sum + Math.max(1, Number(i.qty || i.quantity || 1)), 0);
  // An order with no line items still shipped something; assume one book rather
  // than pretending it was free.
  return n || 1;
}

/**
 * What this order actually earned.
 * A partial-COD order holds only the 10% advance in amount_paise — the rest is
 * collected at the door, so counting the column alone would report a ₹438 sale
 * as ₹44. The balance is added once the parcel is with the customer.
 */
function revenueOf(order, bucket) {
  if (bucket === 'cancelled' || bucket === 'rto' || bucket === 'refunded' || bucket === 'pending') return 0;
  const paid = Number(order.amount_paise || 0) / 100;
  const items = Array.isArray(order.cart_items) ? order.cart_items : [];
  const meta = items.find(i => i && i._payment)?._payment;
  const balance = Number(meta?.balance || 0);
  if (balance > 0 && bucket === 'delivered') return paid + balance;
  if (balance > 0 && bucket === 'in_transit') return paid + balance;   // expected, still provisional
  return paid;
}

function costsOf(order, bucket, rates) {
  const units = unitsOf(order);
  // Paid to acquire the click; nothing that happens later gives it back.
  const ads = rates.adCostPerOrder;

  let shipping = 0;
  let cogs = 0;
  switch (bucket) {
    case 'delivered':
    case 'in_transit':
      shipping = rates.shippingPerOrder;
      cogs = rates.bookCost * units;
      break;
    case 'rto':
      // Out and back. The books return to stock, so only the freight is lost.
      shipping = rates.shippingPerOrder * 2;
      break;
    case 'refunded':
      // Refunded after despatch means it travelled both ways; refunded before
      // despatch is a cancellation by another name and the charge is reversed.
      shipping = order.tracking_id ? rates.shippingPerOrder * 2 : 0;
      break;
    case 'cancelled':
      // Reversed to the NimbusPost wallet.
      shipping = 0;
      break;
    default:
      break;   // pending: nothing has been spent beyond the ad
  }
  return { ads, shipping, cogs, units };
}

function emptyBucket() {
  return { orders: 0, units: 0, revenue: 0, ads: 0, shipping: 0, cogs: 0, net: 0 };
}

/**
 * @param {Array} orders  rows from the orders table
 * @param {object} rateOverrides  partial DEFAULT_RATES
 */
function computeProfit(orders, rateOverrides = {}) {
  const rates = { ...DEFAULT_RATES, ...rateOverrides };
  const buckets = Object.fromEntries(BUCKETS.map(b => [b, emptyBucket()]));
  const totals = emptyBucket();

  for (const order of orders || []) {
    const bucket = classify(order);
    const revenue = revenueOf(order, bucket);
    const { ads, shipping, cogs, units } = costsOf(order, bucket, rates);
    const net = revenue - ads - shipping - cogs;

    const b = buckets[bucket];
    b.orders += 1; b.units += units;
    b.revenue += revenue; b.ads += ads; b.shipping += shipping; b.cogs += cogs; b.net += net;

    totals.orders += 1; totals.units += units;
    totals.revenue += revenue; totals.ads += ads; totals.shipping += shipping; totals.cogs += cogs; totals.net += net;
  }

  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) =>
    [k, k === 'orders' || k === 'units' ? v : Math.round(v * 100) / 100]));

  const shipped = buckets.delivered.orders + buckets.in_transit.orders + buckets.rto.orders;
  return {
    rates,
    buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, round(v)])),
    labels: BUCKET_LABELS,
    totals: round(totals),
    rates_applied_to: {
      ads: 'every order in the period',
      shipping: 'delivered and in-transit once, RTO twice, cancelled never',
      books: 'delivered and in-transit only (returned stock is not consumed)',
    },
    kpis: {
      // Share of despatched parcels that came back. The number that decides
      // whether COD is worth running.
      rto_rate_pct: shipped ? Math.round((buckets.rto.orders / shipped) * 10000) / 100 : 0,
      cancel_rate_pct: totals.orders ? Math.round((buckets.cancelled.orders / totals.orders) * 10000) / 100 : 0,
      avg_order_value: buckets.delivered.orders
        ? Math.round((buckets.delivered.revenue / buckets.delivered.orders) * 100) / 100 : 0,
      profit_per_delivered_order: buckets.delivered.orders
        ? Math.round((buckets.delivered.net / buckets.delivered.orders) * 100) / 100 : 0,
      margin_pct: totals.revenue ? Math.round((totals.net / totals.revenue) * 10000) / 100 : 0,
    },
  };
}

module.exports = { DEFAULT_RATES, BUCKETS, BUCKET_LABELS, classify, unitsOf, revenueOf, costsOf, computeProfit };
