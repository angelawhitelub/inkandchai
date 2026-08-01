/**
 * Scheduled function: hourly READ-ONLY refund reconciliation.
 *
 * Asks PhonePe for the true state of every refund we're owed and flips
 * PENDING → refunded (notifying the customer) as soon as PhonePe confirms it.
 * It NEVER re-issues a refund — that stays with phonepe-retry-refunds-scheduled
 * in the 1–6 PM IST window, where PhonePe's merchant-balance policy actually
 * lets a re-attempt clear and where burning the 10-attempt cap is intended.
 *
 * Why this exists: refunds complete at any hour. One that completed at 12:45 AM
 * used to sit "refund pending" in admin — and the customer stayed un-notified —
 * until the afternoon re-issue window ran, ~12 hours later.
 */

const HEADERS = { 'Content-Type': 'application/json' };

exports.handler = async () => {
  const secret = process.env.ADMIN_SECRET;
  const site = String(process.env.SITE_URL || process.env.URL || 'https://inkandchai.in').replace(/\/$/, '');
  if (!secret) {
    console.error('[phonepe-reconcile-refunds] ADMIN_SECRET is not configured');
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Scheduler auth not configured' }) };
  }

  try {
    const response = await fetch(`${site}/.netlify/functions/phonepe-retry-refunds-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': secret },
      body: JSON.stringify({ reconcile_only: true }),
    });
    if (!response.ok && response.status !== 202) {
      const detail = await response.text().catch(() => '');
      throw new Error(`worker enqueue returned ${response.status}: ${detail.slice(0, 300)}`);
    }
    console.log(`[phonepe-reconcile-refunds] worker enqueued (${response.status})`);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ enqueued: true }) };
  } catch (error) {
    console.error('[phonepe-reconcile-refunds] failed:', error.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message }) };
  }
};
