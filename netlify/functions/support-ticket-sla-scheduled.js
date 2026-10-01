/**
 * Scheduled: support-ticket-sla-scheduled
 *
 * Hourly. The promise on /support/ is a reply within 24 hours and a resolution
 * within 48. This is what keeps it:
 *
 *   - 24 h with no reply        → the owner is nudged, once
 *   - past 48 h, still open     → the customer is told, in plain words, that it
 *                                 is taking longer than expected (and the owner
 *                                 is told it is overdue). Repeated every further
 *                                 48 h, three times at most.
 *   - waiting on the customer   → never late, never chased
 *
 * Each notice is claimed with a conditional update before it is sent, so two
 * overlapping runs cannot send it twice. Closing a ticket is what stops all of
 * this.
 *
 * SUPPORT_TICKET_SLA (wrangler.toml [vars]) = "off" stops it. Over HTTP (owner
 * only) it is a dry run unless the body says { dry_run: false }.
 */

const { requireAdmin } = require('./utils/admin-auth');
const A = require('./utils/support-ticket-actions');
const D = require('./utils/support-ticket-deps');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const slaOn = () => !['off', 'false', '0', 'no'].includes(String(process.env.SUPPORT_TICKET_SLA ?? 'on').trim().toLowerCase());

exports.handler = async (event = {}) => {
  const fromCron = !event.rawUrl;
  let dryRun = false;
  if (!fromCron) {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
    const blocked = requireAdmin(event, CORS);
    if (blocked) return blocked;
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    dryRun = body.dry_run !== false;
  } else if (!slaOn()) {
    console.log('[support-sla] skipped: SUPPORT_TICKET_SLA is off');
    return json(200, { ok: true, enabled: false });
  }
  try {
    const out = await A.runSlaSweep(D.realDeps(), { dryRun });
    console.log(`[support-sla] ${dryRun ? 'dry run' : 'run'} checked=${out.checked} delay=${(out.delay_notices || []).length} nudges=${(out.owner_nudges || []).length} failed=${(out.failed || []).length}${out.skipped ? ' skipped=' + out.skipped : ''}${out.error ? ' error=' + out.error : ''}`);
    return json(out.ok ? 200 : 502, out);
  } catch (e) {
    console.error('[support-sla]', e);
    return json(500, { error: e.message });
  }
};
