'use strict';

/**
 * Daily profit, today included, from REAL ad spend and AVERAGE outcomes.
 *
 * profit-model.js costs an order by what has happened to it. That is right for
 * a month, but useless for today: today's orders have not shipped, so they show
 * ₹0 revenue against a real ad bill and every day looks like a loss until the
 * couriers catch up a week later.
 *
 * So an order still in flight is valued by what orders LIKE IT usually turn
 * into. "Like it" means the same payment kind -- COD and prepaid behave very
 * differently (a prepaid parcel is rarely refused, a COD one often is) -- and
 * the rates come from orders old enough to have finished: 20 to 80 days.
 *
 *   not shipped yet   value × P(delivered); shipping × (P(delivered) + 2·P(RTO));
 *                     stock × P(delivered)
 *   in transit        the same, with P(delivered | shipped)
 *   finished          what actually happened (profit-model's revenue and costs)
 *
 * Ad spend is the platforms' own figure for that IST day when we have it, and
 * the owner's per-order average only for days with no spend data at all.
 */

const { classify, unitsOf, revenueOf, costsOf, DEFAULT_RATES } = require('./profit-model');
const { classifyShipmentMoney } = require('./shipment-money');
const { isReplacementOrder } = require('./replacement-order');
const { istDay } = require('./ad-spend');

const MATURE_MIN_DAYS = 20;
const MATURE_MAX_DAYS = 80;
// Below this many finished orders of a kind, its own rates are too noisy; the
// all-orders rates are used instead.
const MIN_SAMPLE = 40;

function payKind(order) {
  if (isReplacementOrder(order)) return 'replacement';
  const t = String(order.shipment_payment_type || '').toLowerCase();
  if (t === 'prepaid') return 'prepaid';
  if (t === 'cod' || t === 'partial_cod') return 'cod';
  try {
    return classifyShipmentMoney(order, false).isCOD ? 'cod' : 'prepaid';
  } catch {
    return 'cod';   // a partial-COD row missing its metadata is still COD
  }
}

/** Full value of the order: a partial-COD order's 10% advance plus the balance due at the door. */
function orderValue(order) {
  if (isReplacementOrder(order)) return 0;
  try { return classifyShipmentMoney(order, false).orderValueRs; } catch { return Number(order.amount_paise || 0) / 100; }
}

function rates(counts) {
  const finished = counts.delivered + counts.rto + counts.cancelled + counts.refunded;
  const shipped = counts.delivered + counts.rto;
  return {
    sample: finished,
    p_delivered: finished ? counts.delivered / finished : 0,
    p_rto: finished ? counts.rto / finished : 0,
    p_cancelled: finished ? (counts.cancelled + counts.refunded) / finished : 0,
    p_delivered_if_shipped: shipped ? counts.delivered / shipped : 0,
  };
}

/** Outcome rates by payment kind, from orders old enough to have finished. */
function outcomeAverages(orders, now = Date.now()) {
  const lo = now - MATURE_MAX_DAYS * 86400000;
  const hi = now - MATURE_MIN_DAYS * 86400000;
  const zero = () => ({ delivered: 0, rto: 0, cancelled: 0, refunded: 0 });
  const counts = { cod: zero(), prepaid: zero(), all: zero() };
  for (const o of orders || []) {
    const t = Date.parse(o.created_at);
    if (!(t >= lo && t < hi)) continue;
    const kind = payKind(o);
    if (kind === 'replacement') continue;
    const bucket = classify(o);
    if (!(bucket in counts.all)) continue;   // still in transit / unshipped after 20 days: not evidence
    counts[kind][bucket] += 1;
    counts.all[bucket] += 1;
  }
  const all = rates(counts.all);
  const pick = (k) => { const r = rates(counts[k]); return r.sample >= MIN_SAMPLE ? r : { ...all, fallback: true }; };
  return { cod: pick('cod'), prepaid: pick('prepaid'), all, window_days: [MATURE_MIN_DAYS, MATURE_MAX_DAYS] };
}

/** Expected revenue and non-ad costs of one order. */
function expectedOrder(order, avgs, r) {
  const bucket = classify(order);
  const units = unitsOf(order);
  const kind = payKind(order);
  if (bucket !== 'pending' && bucket !== 'in_transit') {
    const { shipping, cogs } = costsOf(order, bucket, r);
    return { bucket, kind, units, revenue: revenueOf(order, bucket), shipping, cogs, settled: true };
  }
  if (kind === 'replacement') {
    // Sent free: no revenue whatever happens, but the parcel and the books go.
    return { bucket, kind, units, revenue: 0, shipping: r.shippingPerOrder, cogs: r.bookCost * units, settled: false };
  }
  const a = avgs[kind] || avgs.all;
  const pDel = bucket === 'in_transit' ? a.p_delivered_if_shipped : a.p_delivered;
  const pRto = bucket === 'in_transit' ? 1 - a.p_delivered_if_shipped : a.p_rto;
  return {
    bucket, kind, units,
    revenue: orderValue(order) * pDel,
    shipping: r.shippingPerOrder * (pDel + 2 * pRto),
    cogs: r.bookCost * units * pDel,
    settled: false,
  };
}

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * @param orders      rows created within the days asked for (others are ignored)
 * @param days        IST days, YYYY-MM-DD, newest first
 * @param spend       ad-spend fetchSpend() result
 * @param avgs        outcomeAverages() result
 * @param platforms   platforms connected (have ever reported), e.g. ['google','meta']
 */
function dailyProfit({ orders, days, spend, avgs, rateOverrides = {}, platforms = [] }) {
  const r = { ...DEFAULT_RATES, ...rateOverrides };
  const byDay = Object.fromEntries(days.map((d) => [d, []]));
  for (const o of orders || []) {
    const d = istDay(o.created_at);
    if (byDay[d]) byDay[d].push(o);
  }
  return days.map((day) => {
    const list = byDay[day];
    const row = { day, orders: list.length, cod: 0, prepaid: 0, replacements: 0, order_value: 0, revenue: 0, shipping: 0, cogs: 0, settled: 0 };
    for (const o of list) {
      const e = expectedOrder(o, avgs, r);
      if (e.kind === 'cod') row.cod += 1; else if (e.kind === 'prepaid') row.prepaid += 1; else row.replacements += 1;
      if (e.bucket !== 'cancelled' && e.bucket !== 'refunded') row.order_value += orderValue(o);
      row.revenue += e.revenue; row.shipping += e.shipping; row.cogs += e.cogs;
      if (e.settled) row.settled += 1;
    }
    const s = spend && spend.byDay && spend.byDay[day];
    const actual = !!s && platforms.length > 0;
    row.ads_google = s ? r2(s.google || 0) : 0;
    row.ads_meta = s ? r2(s.meta || 0) : 0;
    row.ads = actual ? r2(s.total) : r2(r.adCostPerOrder * list.length);
    row.ads_source = actual ? 'actual' : 'average';
    row.ads_per_order = list.length ? r2(row.ads / list.length) : null;
    for (const k of ['order_value', 'revenue', 'shipping', 'cogs']) row[k] = r2(row[k]);
    row.net = r2(row.revenue - row.ads - row.shipping - row.cogs);
    return row;
  });
}

/** IST days from `count - 1` days ago to today, newest first. */
function lastDays(count, now = new Date()) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(istDay(new Date(now.getTime() - i * 86400000)));
  return out;
}

module.exports = { MATURE_MIN_DAYS, MATURE_MAX_DAYS, MIN_SAMPLE, payKind, orderValue, outcomeAverages, expectedOrder, dailyProfit, lastDays };
