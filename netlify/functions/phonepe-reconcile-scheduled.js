/**
 * Scheduled function: close out PhonePe checkouts that never completed.
 *
 * phonepe-reconcile could always do this, but nothing ever called it except a
 * button and a poller that only runs while the admin page is open. So orders
 * the customer abandoned at the payment screen sat in pending_phonepe forever:
 * the payment sweep only carries an order FORWARD when money landed, and
 * auto-cancel-stale-cod only looks at cod_pending. Five had built up, the
 * oldest ten days old, all of them showing in the panel's unshipped list.
 *
 * Shares the hourly "15 * * * *" trigger with auto-cancel-stale-cod rather than
 * adding a cron — the work is one PhonePe lookup per pending order, and there
 * are normally none.
 *
 * Reconcile decides what happens; this only asks. COMPLETED is marked paid,
 * FAILED is cancelled and the customer told, an order PhonePe has no record of
 * is cancelled silently once it is old enough, and a lookup that simply errored
 * is left alone.
 */

const HEADERS = { 'Content-Type': 'application/json' };

exports.handler = async () => {
  const secret = process.env.ADMIN_SECRET;
  const site = String(process.env.SITE_URL || process.env.URL || 'https://inkandchai.in').replace(/\/$/, '');
  if (!secret) {
    console.error('[phonepe-reconcile-scheduler] ADMIN_SECRET is not configured');
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Scheduler auth not configured' }) };
  }

  try {
    const response = await fetch(`${site}/.netlify/functions/phonepe-reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': secret },
      body: JSON.stringify({ all_pending: true }),
    });
    const detail = await response.text().catch(() => '');
    if (!response.ok) throw new Error(`reconcile returned ${response.status}: ${detail.slice(0, 300)}`);

    let summary = null;
    try { summary = JSON.parse(detail).summary; } catch { /* logged raw below */ }
    // Worth a line in the log even when it is empty: a run that finds nothing is
    // the evidence that nothing is piling up.
    console.log('[phonepe-reconcile-scheduler]', JSON.stringify(summary || detail.slice(0, 200)));
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, summary }) };
  } catch (error) {
    console.error('[phonepe-reconcile-scheduler] failed:', error.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message }) };
  }
};
