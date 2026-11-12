/**
 * Scheduled: xpressbees-queue-sweep-scheduled
 *
 * Every 15 minutes (jobs.toml). Owner's ask, 12 Nov 2026: a cancelled order
 * should leave the XpressBees panel's Pending list by itself, not wait for
 * "Clear Shipped from XpressBees Pending" or the 09:00 cleanup.
 *
 * The same guarded run as xpressbees-queue-cleanup-scheduled (any_courier +
 * closed_here), over the newest SWEEP_PAGES pages only, where new cancels and
 * fresh other-courier bookings sit. The 09:00 job still reads the whole panel.
 * An admin cancel clears its row at once (utils/xb-queue-clear); this catches
 * every other way an order gets cancelled: the customer, the WhatsApp bot,
 * auto-cancel of stale COD, bulk updates.
 *
 * Only unbooked 'new' rows with no waybill are ever cancelled. Nothing is sent
 * to customers. Failures are logged, not WhatsApped every 15 minutes; the
 * 09:00 run alerts the owner if the problem persists.
 * XPRESSBEES_QUEUE_CLEANUP = "off" stops this too.
 */

const { runCleanup, cleanupOn } = require('./xpressbees-queue-cleanup-scheduled');

const SWEEP_PAGES = 5;   // 1,000 newest panel rows

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function runSweep(deps = {}) {
  return runCleanup({ cancel: deps.cancel, alertOwner: async () => {} }, { dryRun: false, maxPages: SWEEP_PAGES });
}

exports.handler = async () => {
  if (!cleanupOn()) return json(200, { ok: true, enabled: false });
  try {
    const out = await runSweep();
    console.log(`[xb-queue-sweep] to_cancel=${out.to_cancel} cancelled=${(out.cancelled || []).length} failed=${out.failed}${out.error ? ' error=' + out.error : ''}`);
    return json(out.ok ? 200 : 502, out);
  } catch (e) {
    console.error('[xb-queue-sweep]', e);
    return json(500, { error: e.message });
  }
};

exports.runSweep = runSweep;
exports.SWEEP_PAGES = SWEEP_PAGES;
