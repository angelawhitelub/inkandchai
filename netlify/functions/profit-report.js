/**
 * Netlify Function: profit-report
 * GET /.netlify/functions/profit-report?days=30
 * Admin endpoint — net profit across a date range. Requires X-Admin-Key.
 *
 * ?days   = 7 | 30 | 90 | 180 | 365 | all   (default 30)
 * ?ad, ?ship, ?book  override the per-order averages (rupees)
 *
 * The arithmetic lives in utils/profit-model.js; this function's only job is
 * to fetch the orders honestly. That means paginating: Supabase caps .select()
 * at 1000 rows, and a truncated fetch here would silently under-report every
 * figure on the page with no sign that anything was wrong.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { computeProfit, DEFAULT_RATES } = require('./utils/profit-model');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

const PAGE = 1000;
const MAX_ROWS = 60000;   // guard: ~6x the current order count

const num = (v, fallback) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const block = requireAdmin(event, CORS); if (block) return block;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase env vars not set' }) };
  }

  const q = event.queryStringParameters || {};
  const daysRaw = String(q.days || '30').toLowerCase();
  const days = daysRaw === 'all' ? null : Math.max(1, parseInt(daysRaw, 10) || 30);

  const rates = {
    adCostPerOrder:   num(q.ad,   DEFAULT_RATES.adCostPerOrder),
    shippingPerOrder: num(q.ship, DEFAULT_RATES.shippingPerOrder),
    bookCost:         num(q.book, DEFAULT_RATES.bookCost),
  };

  const since = days ? new Date(Date.now() - days * 86400_000).toISOString() : null;

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const orders = [];
    let truncated = false;

    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      let query = supabase
        .from('orders')
        .select('razorpay_order_id,status,amount_paise,cart_items,tracking_id,last_nimbuspost_status,created_at')
        // Same exclusion the admin order list uses — paperbound is a separate storefront.
        .or('source.is.null,source.neq.paperbound')
        .order('created_at', { ascending: false })
        .range(from, from + PAGE - 1);
      if (since) query = query.gte('created_at', since);

      const { data, error } = await query;
      if (error) throw new Error(error.message);
      orders.push(...(data || []));
      if (!data || data.length < PAGE) break;
      if (from + PAGE >= MAX_ROWS) truncated = true;
    }

    const report = computeProfit(orders, rates);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        range: { days: days || 'all', since, until: new Date().toISOString() },
        orders_counted: orders.length,
        truncated,
        ...report,
      }),
    };
  } catch (err) {
    console.error('[profit-report]', err);
    // Never dress a failure up as a zero-profit report.
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
