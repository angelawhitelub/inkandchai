/**
 * Scheduled function: securely enqueue the replacement-push worker.
 * The sweep itself runs in the background function, which is not bound by the
 * 10-second synchronous limit.
 */

const HEADERS = { 'Content-Type': 'application/json' };

exports.handler = async () => {
  const secret = process.env.ADMIN_SECRET;
  const site = String(process.env.SITE_URL || process.env.URL || 'https://inkandchai.in').replace(/\/$/, '');
  if (!secret) {
    console.error('[replacement-push-scheduler] ADMIN_SECRET is not configured');
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Scheduler auth not configured' }) };
  }

  try {
    const response = await fetch(`${site}/.netlify/functions/auto-push-replacements-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': secret },
      body: '{}',
    });
    if (!response.ok && response.status !== 202) {
      const detail = await response.text().catch(() => '');
      throw new Error(`worker enqueue returned ${response.status}: ${detail.slice(0, 300)}`);
    }
    console.log(`[replacement-push-scheduler] worker enqueued (${response.status})`);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ enqueued: true }) };
  } catch (error) {
    console.error('[replacement-push-scheduler] failed:', error.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message }) };
  }
};
