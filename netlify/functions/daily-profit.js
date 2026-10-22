/**
 * Netlify Function: daily-profit   (admin)
 * GET /.netlify/functions/daily-profit?days=14[&ship=62&book=80&ad=92][&sync=meta]
 *
 * Profit per IST day, today included: real ad spend from Google Ads and Meta
 * (ad_spend_daily) against each day's orders, with orders still in flight
 * valued by the average outcome of past orders of the same payment kind. See
 * utils/daily-profit.js for the model. `ad` is used only for days with no
 * spend data at all.
 *
 * sync=meta pulls Meta's figures first (the same pull the hourly job makes),
 * so a fresh token can be checked without waiting for the hour.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const S = require('./utils/ad-spend');
const D = require('./utils/daily-profit');
const { DEFAULT_RATES } = require('./utils/profit-model');
const { syncMeta } = require('./meta-ad-spend-scheduled');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const PAGE = 1000;
const num = (v, fallback) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : fallback; };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return json(500, { error: 'Supabase is not configured.' });

  const q = event.queryStringParameters || {};
  const count = Math.min(90, Math.max(1, parseInt(q.days || '14', 10) || 14));
  const rateOverrides = {
    adCostPerOrder: num(q.ad, DEFAULT_RATES.adCostPerOrder),
    shippingPerOrder: num(q.ship, DEFAULT_RATES.shippingPerOrder),
    bookCost: num(q.book, DEFAULT_RATES.bookCost),
  };
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    const sync = q.sync === 'meta' ? await syncMeta({ db }) : null;

    const now = new Date();
    const days = D.lastDays(count, now);
    const oldestDay = days[days.length - 1];
    // Enough history for the outcome averages as well as the days shown.
    const since = new Date(Math.min(S.istDayStart(oldestDay).getTime(), now.getTime() - D.MATURE_MAX_DAYS * 86400000)).toISOString();

    const orders = [];
    for (let from = 0; from < 60000; from += PAGE) {
      const { data, error } = await db.from('orders')
        .select('razorpay_order_id,status,amount_paise,advance_paid_paise,razorpay_payment_id,shipment_payment_type,source,cart_items,tracking_id,shipment_moved_at,last_nimbuspost_status,created_at')
        .or('source.is.null,source.neq.paperbound')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      orders.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }

    const [spend, firstDays] = await Promise.all([S.fetchSpend(db, oldestDay, days[0]), S.coverage(db)]);
    const platforms = Object.keys(firstDays);
    const avgs = D.outcomeAverages(orders, now.getTime());
    const rows = D.dailyProfit({ orders, days, spend, avgs, rateOverrides, platforms });

    const sum = (k) => Math.round(rows.reduce((s, r) => s + (r[k] || 0), 0) * 100) / 100;
    const totals = Object.fromEntries(['orders', 'order_value', 'revenue', 'ads', 'ads_google', 'ads_meta', 'shipping', 'cogs', 'net'].map((k) => [k, sum(k)]));
    totals.ads_per_order = totals.orders ? Math.round((totals.ads / totals.orders) * 100) / 100 : null;

    return json(200, {
      ok: true,
      generated_at: now.toISOString(),
      rates: { ...DEFAULT_RATES, ...rateOverrides },
      averages: avgs,
      connected: {
        google: firstDays.google ? { since: firstDays.google } : null,
        meta: firstDays.meta ? { since: firstDays.meta } : null,
        meta_configured: !!(process.env.META_ADS_TOKEN && S.metaAccounts().length),
        google_key_configured: String(process.env.AD_SPEND_KEY || '').length >= 16,
        table_missing: !!spend.missing,
      },
      sync,
      days: rows,
      totals,
    });
  } catch (e) {
    console.error('[daily-profit]', e);
    return json(500, { ok: false, error: e.message });
  }
};
