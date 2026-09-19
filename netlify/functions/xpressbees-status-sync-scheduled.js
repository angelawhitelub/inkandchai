/**
 * Scheduled function: enqueue the XpressBees status poller.
 *
 * Same shape as nimbuspost-awb-sync-scheduled: the cron entry point stays
 * tiny and the long-running work happens in the background handler, which is
 * admin-guarded so the enqueue has to carry ADMIN_SECRET.
 */

const HEADERS = { 'Content-Type': 'application/json' };

exports.handler = async () => {
  const secret = process.env.ADMIN_SECRET;
  const site = String(process.env.SITE_URL || process.env.URL || 'https://inkandchai.in').replace(/\/$/, '');
  if (!secret) {
    console.error('[xpressbees-status-sync-scheduler] ADMIN_SECRET is not configured');
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Scheduler auth not configured' }) };
  }

  try {
    const response = await fetch(`${site}/.netlify/functions/xpressbees-status-sync-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': secret },
      body: '{}',
    });
    if (!response.ok && response.status !== 202) {
      const detail = await response.text().catch(() => '');
      throw new Error(`worker enqueue returned ${response.status}: ${detail.slice(0, 300)}`);
    }
    console.log(`[xpressbees-status-sync-scheduler] worker enqueued (${response.status})`);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ enqueued: true }) };
  } catch (error) {
    console.error('[xpressbees-status-sync-scheduler] failed:', error.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message }) };
  }
};
