/**
 * Scheduled function: ask recently-delivered customers for a review.
 *
 * request-reviews has existed since the review system was built but was never
 * scheduled -- it only ran from a button in the admin panel that nobody pressed,
 * so in 5,721 delivered orders not one customer was ever asked. This is what
 * actually makes the feature run.
 *
 * Deliberately conservative:
 *   days_back 21 -- someone whose book arrived in May will not remember it, and
 *                   asking them reads as spam on a number we need to keep in
 *                   good standing.
 *   limit 300    -- comfortably above a normal day's deliveries, so the 21-day
 *                   backlog drains over the first few runs rather than going out
 *                   as one burst of thousands.
 *
 * Dedup is the orders.review_requested_at column, which request-reviews stamps
 * after each send. If that column is missing the stamp silently no-ops and this
 * will re-ask the same people daily -- run the migration before enabling.
 */

const HEADERS = { 'Content-Type': 'application/json' };

exports.handler = async () => {
  const secret = process.env.ADMIN_SECRET;
  const site = String(process.env.SITE_URL || process.env.URL || 'https://inkandchai.in').replace(/\/$/, '');
  if (!secret) {
    console.error('[review-scheduler] ADMIN_SECRET is not configured');
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Scheduler auth not configured' }) };
  }

  try {
    const response = await fetch(`${site}/.netlify/functions/request-reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': secret },
      body: JSON.stringify({ days_back: 21, limit: 300, require_dedup: true }),
    });
    const detail = await response.text().catch(() => '');
    if (!response.ok) throw new Error(`request-reviews returned ${response.status}: ${detail.slice(0, 300)}`);
    console.log(`[review-scheduler] ${detail.slice(0, 300)}`);
    return { statusCode: 200, headers: HEADERS, body: detail || '{"ok":true}' };
  } catch (error) {
    console.error('[review-scheduler] failed:', error.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message }) };
  }
};
