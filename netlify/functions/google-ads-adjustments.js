/**
 * Serves the Google Ads conversion-adjustment upload file.
 *
 * Register this URL in Google Ads as a scheduled upload (Tools → Data manager
 * → Uploads → Schedules, source "HTTPS") once per account. Google fetches it
 * daily and retracts the conversions for orders that were cancelled, came back
 * RTO, or were refunded — the revenue those conversions claimed was never
 * collected, and until now Ads had no way to learn that.
 *
 * AUTH
 * ----
 * Google's scheduled fetch cannot send custom headers, so the only credential
 * available is one carried in the URL: `?key=<GADS_FEED_KEY>`. Nothing here is
 * writable and the file contains order ids and statuses only — no customer
 * names, addresses, emails or phone numbers. Admin sessions are also accepted
 * so the feed can be inspected from the panel without handling the key.
 *
 * PARAMETERS
 * ----------
 *   key=…       shared secret (GADS_FEED_KEY), or an admin session
 *   account=a|b picks which conversion action name to write into the file
 *   format=json returns a summary instead of the CSV, for eyeballing
 *   days=N      override the lookback (default 54, Google's ceiling is 55)
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const {
  LOSS_STATUSES,
  MAX_CONVERSION_AGE_DAYS,
  MIN_ADJUSTMENT_AGE_HOURS,
  buildAdjustmentRows,
  toCsv,
} = require('./utils/google-ads-adjustments');

const PAGE = 1000;

/**
 * The conversion action name differs per account, and Google matches on the
 * name exactly as it is spelled in that account — hence env vars rather than
 * anything derived from the `AW-…/…` send_to ids the tag uses.
 */
function conversionNameFor(account) {
  const a = String(account || 'a').toLowerCase();
  const perAccount = a === 'b'
    ? process.env.GADS_CONVERSION_NAME_B
    : process.env.GADS_CONVERSION_NAME_A;
  return String(perAccount || process.env.GADS_CONVERSION_NAME || '').trim();
}

function timingSafeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** Every loss-status order in the window, paginated — `.select()` silently caps at 1000. */
async function fetchLossOrders(supabase, sinceIso) {
  const columns = [
    'razorpay_order_id', 'razorpay_payment_id', 'status', 'source',
    'amount_paise', 'created_at', 'cancelled_at', 'auto_cancelled_at',
    'refund_updated_at', 'shipment_moved_at', 'last_nimbuspost_event_at',
  ].join(',');

  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('orders')
      .select(columns)
      .in('status', [...LOSS_STATUSES])
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < PAGE) return out;
  }
}

exports.handler = async (event) => {
  const params = (event.queryStringParameters || {});
  const feedKey = process.env.GADS_FEED_KEY;

  const keyOk = Boolean(feedKey) && timingSafeEqual(params.key, feedKey);
  if (!keyOk) {
    const block = requireAdmin(event);
    if (block) return block;
  }

  const conversionName = conversionNameFor(params.account);
  if (!conversionName) {
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Conversion action name not configured. Set GADS_CONVERSION_NAME_A '
             + '(and GADS_CONVERSION_NAME_B for the second Ads account) to the '
             + 'conversion action name exactly as it appears in Google Ads.',
      }),
    };
  }

  const days = Math.min(Number(params.days) || MAX_CONVERSION_AGE_DAYS, MAX_CONVERSION_AGE_DAYS);
  const now = new Date();
  const sinceIso = new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString();

  let orders;
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    orders = await fetchLossOrders(supabase, sinceIso);
  } catch (error) {
    console.error('[google-ads-adjustments] query failed:', error.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message }),
    };
  }

  const { rows, skipped } = buildAdjustmentRows(orders, {
    now,
    maxAgeDays: days,
    minAgeHours: MIN_ADJUSTMENT_AGE_HOURS,
  });

  console.log(`[google-ads-adjustments] account=${params.account || 'a'} scanned=${orders.length} `
    + `retractions=${rows.length} skipped=${JSON.stringify(skipped)}`);

  if (String(params.format || '').toLowerCase() === 'json') {
    const byStatus = {};
    let value = 0;
    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] || 0) + 1;
      value += row.amount;
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        conversion_name: conversionName,
        window_days: days,
        scanned: orders.length,
        retractions: rows.length,
        value_retracted: Math.round(value * 100) / 100,
        by_status: byStatus,
        skipped,
        sample: rows.slice(0, 5),
      }, null, 2),
    };
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="google-ads-conversion-adjustments.csv"',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
    body: toCsv(rows, conversionName),
  };
};
