/**
 * Scheduled: shipment-daily-report-scheduled -- daily, 21:00 IST (jobs.toml)
 *
 * Emails the owner what happened to shipments in the last 24 hours (booked,
 * picked up, delivered, cancelled, came back), where every open parcel stands
 * now, and a CSV of the orders behind the numbers (utils/shipment-daily-report).
 * Owner asked for it as an email on 27 Nov 2026. Internal only, read-only.
 *
 * Config: SHIP_REPORT_EMAILS (comma-separated), else NPU_REPORT_EMAILS, else
 * DAILY_REPORT_EMAIL, else the owner's address (as not-picked-up-report).
 *
 * Admin POST { hours?, dry_run? } runs it now; dry_run returns the numbers
 * and who would get it, and sends nothing.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { sendEmail } = require('./utils/email');
const report = require('./utils/shipment-daily-report');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const list = (v) => String(v || '').split(/[,\s;]+/).map((x) => x.trim()).filter(Boolean);

function recipients() {
  return [...new Set(list(process.env.SHIP_REPORT_EMAILS || process.env.NPU_REPORT_EMAILS || process.env.DAILY_REPORT_EMAIL || 'asfkhn234@gmail.com')
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
}

async function build(db, { hours = 24, now = Date.now() } = {}) {
  const until = new Date(now);
  const since = new Date(now - hours * 3600e3);
  const [events, open] = await Promise.all([report.loadEvents(db, { since, until }), report.loadOpen(db, { until })]);
  return { since, until, ...report.summarise({ events, open, since, until }) };
}

exports.handler = async (event = {}) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const fromCron = !!(event.headers && event.headers['x-cloudflare-cron']);
  if (!fromCron) { const block = requireAdmin(event, CORS); if (block) return block; }

  let body = {};
  try { body = JSON.parse(event.body || '{}') || {}; } catch { body = {}; }
  const hours = Math.min(24 * 7, Math.max(1, Number(body.hours) || 24));
  const dryRun = body.dry_run === true;
  const emails = recipients();

  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const r = await build(db, { hours });
    const numbers = Object.fromEntries(report.EVENTS.map((e) => [e.key, r.counts[e.key].total]));
    const snapshot = Object.fromEntries(Object.entries(r.snapshot).map(([k, v]) => [k, v.total]));
    if (dryRun) return json(200, { dry_run: true, since: r.since, until: r.until, ...numbers, snapshot, rows: r.rows.length, would_email: emails });

    const day = r.until.toISOString().slice(0, 10);
    const sent = [];
    for (const to of emails) {
      const res = await sendEmail({
        to,
        subject: report.subject(r),
        html: report.emailHtml(r),
        attachments: [{ filename: `shipments-${day}.csv`, content: Buffer.from(report.csv(r.rows), 'utf8'), contentType: 'text/csv' }],
      }).catch((e) => ({ ok: false, error: e.message }));
      sent.push({ to, ok: !!(res && res.ok !== false), error: res && res.error });
    }
    console.log(`[shipment-daily-report] ${JSON.stringify(numbers)} email ${sent.filter((s) => s.ok).length}/${sent.length}`);
    return json(200, { sent: true, ...numbers, snapshot, email: sent });
  } catch (e) {
    console.error('[shipment-daily-report]', e);
    return json(500, { error: e.message });
  }
};

exports._test = { build, recipients };
