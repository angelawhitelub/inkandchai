/**
 * Scheduled: xpressbees-queue-cleanup-scheduled
 *
 * Daily at 09:00 IST (jobs.toml). The XpressBees channel importer keeps pulling
 * orders from our feed that another courier ends up shipping, and each one sits
 * in the panel as a bookable duplicate -- which is how a parcel goes out twice.
 * They were cleared by hand: 95 on 30 Sep, 22 on 1 Oct.
 *
 * This runs xpressbees-order-cancel -- the same endpoint, with its three
 * guards, none bypassable: the order must be carried by some courier on our
 * side (or, since 9 Oct, be cancelled/refunded here with no AWB -- it will
 * never ship, and its row otherwise sits in Pending forever), the panel row must be an unbooked 'new' row with no waybill, and rows
 * already cancelled are skipped. A booked XpressBees shipment is never touched.
 * Nothing is sent to customers and our own orders are not changed.
 *
 * XPRESSBEES_QUEUE_CLEANUP (wrangler.toml [vars]) = "off" stops it. The owner
 * hears about it only when a cancel fails. Over HTTP (owner only) it is a dry
 * run unless the body says { dry_run: false }.
 */

const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const PER_RUN = 100;   // one XpressBees call per row; a day's backlog is 20-100

function cleanupOn() {
  const v = String(process.env.XPRESSBEES_QUEUE_CLEANUP ?? 'on').trim().toLowerCase();
  return !['off', 'false', '0', 'no'].includes(v);
}

/** xpressbees-order-cancel, in-process, authenticated as the owner. */
async function defaultCancel(body) {
  const res = await require('./xpressbees-order-cancel').handler({
    httpMethod: 'POST',
    path: '/.netlify/functions/xpressbees-order-cancel',
    headers: { 'content-type': 'application/json', 'x-admin-key': process.env.ADMIN_SECRET || '' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = JSON.parse(res.body || '{}'); } catch { /* reported below */ }
  return { statusCode: res.statusCode, data };
}

async function defaultAlertOwner(text) {
  if (!process.env.STORE_OWNER_PHONE) return;
  try { await require('./utils/whatsapp').sendText(process.env.STORE_OWNER_PHONE, text); } catch { /* logged by caller */ }
}

async function runCleanup(deps = {}, { dryRun = false } = {}) {
  const cancel = deps.cancel || defaultCancel;
  const alertOwner = deps.alertOwner || defaultAlertOwner;
  const r = await cancel({ dry_run: dryRun, any_courier: true, closed_here: true, limit: PER_RUN });
  if (r.statusCode !== 200) {
    const msg = String(r.data.error || `HTTP ${r.statusCode}`).slice(0, 300);
    if (!dryRun) await alertOwner(`⚠️ XpressBees panel cleanup failed: ${msg}`);
    return { ok: false, error: msg };
  }
  const d = r.data;
  const results = Array.isArray(d.results) ? d.results : [];
  const cancelled = results.filter(x => x.ok).flatMap(x => x.orders || []);
  const failed = results.filter(x => !x.ok);
  if (!dryRun && failed.length) {
    await alertOwner(`⚠️ XpressBees panel cleanup: ${cancelled.length} duplicate rows cancelled, ${failed.length} failed:\n`
      + failed.slice(0, 10).map(f => `${(f.orders || f.ids || []).join(',')}: ${String(f.error || f.message || '').slice(0, 120)}`).join('\n'));
  }
  return {
    ok: true, dry_run: dryRun,
    panel_rows_read: d.panel_rows_read, to_cancel: d.to_cancel, booked_left_alone: d.skipped_booked,
    cancelled, failed: failed.length,
    plan: dryRun ? (d.plan || []).map(p => p.order) : undefined,
  };
}

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
  } else if (!cleanupOn()) {
    console.log('[xb-queue-cleanup] skipped: XPRESSBEES_QUEUE_CLEANUP is off');
    return json(200, { ok: true, enabled: false });
  }
  try {
    const out = await runCleanup({}, { dryRun });
    console.log(`[xb-queue-cleanup] ${dryRun ? 'dry run' : 'run'} to_cancel=${out.to_cancel} cancelled=${(out.cancelled || []).length} failed=${out.failed} booked_left_alone=${out.booked_left_alone}${out.error ? ' error=' + out.error : ''}`);
    return json(out.ok ? 200 : 502, out);
  } catch (e) {
    console.error('[xb-queue-cleanup]', e);
    if (!dryRun) await defaultAlertOwner(`⚠️ XpressBees panel cleanup failed: ${e.message}`);
    return json(500, { error: e.message });
  }
};

exports.runCleanup = runCleanup;
