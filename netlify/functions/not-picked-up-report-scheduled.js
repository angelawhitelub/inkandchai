/**
 * Scheduled: not-picked-up-report-scheduled -- daily, 10:00 IST (jobs.toml)
 *
 * Emails and WhatsApps a PDF of every order placed N+ days ago that no courier
 * has picked up, oldest first -- the admin Not Picked Up tab, for people who
 * do not open the admin. Internal only: it goes to the numbers and addresses
 * configured below, never to a customer.
 *
 * Before listing, every AWB the couriers have not been asked about in the last
 * 6 hours is checked live (utils/pickup-live), the same as opening the tab, so
 * the PDF does not list parcels delivered days ago. Answers are recorded in
 * last_courier_status; order status is never touched.
 *
 * Config (Worker vars/secrets):
 *   NPU_REPORT_PHONES    WhatsApp numbers, comma-separated. Empty: email only.
 *   NPU_REPORT_EMAILS    addresses, comma-separated. Default DAILY_REPORT_EMAIL.
 *   NPU_REPORT_MIN_DAYS  default 2.
 *   NPU_REPORT_TEMPLATE  default not_picked_up_report, UTILITY, submitted to
 *                        Meta on 5 Oct 2026 WITHOUT a header, with this body:
 *       Daily report: {{1}} orders placed {{2}}+ days ago have not been picked
 *       up by the courier. The oldest is {{3}} days old. The full list is
 *       attached, oldest first. - Ink & Chai
 *     So each number gets that alert, and the PDF as a plain document, which
 *     WhatsApp delivers only inside the 24-hour window. Add a DOCUMENT header
 *     to the template and the PDF rides on the template instead -- the send
 *     tries that first, no code change needed.
 *
 * Also POSTed by the owner from the admin tab ("Send report now"):
 *   { min_days?, dry_run? }   dry_run builds the list and says who would get it.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { listNotPicked, REPORT_DAYS } = require('./utils/not-picked-up-list');
const { buildNotPickedPdf } = require('./utils/not-picked-up-pdf');
const { checkPickups } = require('./utils/pickup-live');
const { sendEmail } = require('./utils/email');
const { sendWhatsApp, sendDocument, uploadMedia, normalizePhone } = require('./utils/whatsapp');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const list = (v) => String(v || '').split(/[,\s;]+/).map((x) => x.trim()).filter(Boolean);
const STALE_MS = 6 * 3600 * 1000;
const LIVE_CAP = 250;

function recipients() {
  const phones = [...new Set(list(process.env.NPU_REPORT_PHONES).map(normalizePhone).filter(Boolean))];
  const emails = [...new Set(list(process.env.NPU_REPORT_EMAILS || process.env.DAILY_REPORT_EMAIL || 'asfkhn234@gmail.com')
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
  return { phones, emails };
}

/** Ask the couriers about AWBs nobody has checked in 6 h; record the answers. */
async function refreshStale(db, orders, now) {
  const stale = orders
    .filter((o) => String(o.tracking_id || '').trim()
      && (!o.last_courier_status_at || now - Date.parse(o.last_courier_status_at) > STALE_MS))
    .slice(0, LIVE_CAP);
  if (!stale.length) return { checked: 0 };
  const live = await checkPickups(stale);
  const at = new Date(now).toISOString();
  const counts = {};
  for (const o of stale) {
    const r = live.get(o.id);
    if (!r) continue;
    counts[r.state] = (counts[r.state] || 0) + 1;
    if (r.state === 'unknown' || r.status === o.last_courier_status) continue;
    const { error } = await db.from('orders')
      .update({ last_courier_status: String(r.status).slice(0, 200), last_courier_status_at: at }).eq('id', o.id);
    if (error) console.warn('[not-picked-up-report] record', o.razorpay_order_id, error.message);
  }
  return { checked: stale.length, ...counts };
}

function emailHtml({ count, minDays, oldestDays, notBooked, when }) {
  return `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#222;max-width:560px;">
    <h2 style="margin:0 0 6px;font-size:18px;">Not picked up for ${minDays}+ days: ${count}</h2>
    <p style="color:#666;margin:0 0 14px;font-size:12px;">${when} IST</p>
    <p style="margin:0 0 10px;">${count - notBooked} booked and waiting for the courier, ${notBooked} not booked yet. The oldest is <strong>${oldestDays} days</strong> old.</p>
    <p style="margin:0 0 10px;">The full list is attached as a PDF, oldest first. To cancel and refund any of them, open <a href="https://inkandchai.in/admin/#notpicked">Admin → Not Picked Up</a>; the courier is asked again before anything is cancelled.</p>
  </div>`;
}

exports.handler = async (event = {}) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const fromCron = !!(event.headers && event.headers['x-cloudflare-cron']);
  if (!fromCron) { const block = requireAdmin(event, CORS); if (block) return block; }

  let body = {};
  try { body = JSON.parse(event.body || '{}') || {}; } catch { body = {}; }
  const minDays = Math.min(30, Math.max(1, Math.round(Number(body.min_days) || Number(process.env.NPU_REPORT_MIN_DAYS) || 2)));
  const dryRun = body.dry_run === true;
  const { phones, emails } = recipients();
  const now = Date.now();

  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const first = await listNotPicked(db, { minHours: minDays * 24, days: REPORT_DAYS, now });
    const live = await refreshStale(db, first.orders, now).catch((e) => ({ error: e.message }));
    const { rows } = live.checked ? await listNotPicked(db, { minHours: minDays * 24, days: REPORT_DAYS, now }) : first;

    const generatedAt = new Date(now);
    const pdf = await buildNotPickedPdf(rows, { minDays, generatedAt });
    const when = generatedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const filename = `not-picked-up-${minDays}d-${generatedAt.toISOString().slice(0, 10)}.pdf`;
    const summary = { count: pdf.count, min_days: minDays, oldest_days: pdf.oldestDays, not_booked: pdf.notBooked, live };

    if (dryRun) return json(200, { dry_run: true, ...summary, would_email: emails, would_whatsapp: phones, pdf_bytes: pdf.bytes.length });
    if (!pdf.count) {
      console.log('[not-picked-up-report] nothing waiting — not sent');
      return json(200, { sent: false, reason: 'nothing waiting for pickup', ...summary });
    }

    const email = [];
    for (const to of emails) {
      const r = await sendEmail({
        to,
        subject: `⏳ ${pdf.count} orders not picked up for ${minDays}+ days (oldest ${pdf.oldestDays}d) · ${when}`,
        html: emailHtml({ ...pdf, minDays, when }),
        attachments: [{ filename, content: Buffer.from(pdf.bytes), contentType: 'application/pdf' }],
      }).catch((e) => ({ ok: false, error: e.message }));
      email.push({ to, ok: !!(r && r.ok !== false), error: r && r.error });
    }

    const whatsapp = [];
    if (phones.length) {
      const media = await uploadMedia(pdf.bytes, { mime: 'application/pdf', filename });
      const template = process.env.NPU_REPORT_TEMPLATE || 'not_picked_up_report';
      const params = [pdf.count, minDays, pdf.oldestDays];
      for (const to of phones) {
        // 1. The template with the PDF as its document header -- reaches anyone.
        if (media.ok) {
          const withPdf = await sendWhatsApp({ to, template, params, headerDocument: { id: media.id, filename } });
          if (withPdf.ok) { whatsapp.push({ to, ok: true, via: 'template + pdf' }); continue; }
        }
        // 2. The same template with no header (how it was submitted on 5 Oct
        //    2026): the alert always lands, and opens nothing by itself.
        const alert = await sendWhatsApp({ to, template, params });
        // 3. The PDF as a plain document, delivered only inside the 24 h window.
        const doc = media.ok
          ? await sendDocument(to, {
            id: media.id, filename,
            caption: `${pdf.count} orders placed ${minDays}+ days ago have not been picked up. Oldest: ${pdf.oldestDays} days. Oldest first. - Ink & Chai`,
          })
          : { ok: false };
        whatsapp.push({
          to,
          ok: !!(alert.ok || doc.ok),
          via: [alert.ok && 'template', doc.ok && 'pdf'].filter(Boolean).join(' + ') || undefined,
          error: doc.ok ? undefined
            : alert.ok ? 'alert sent; PDF not delivered (the number has not messaged us in 24 h) — it is in the email'
              : `template "${template}" not approved yet and the number has not messaged us in 24 h`,
        });
      }
    }

    console.log(`[not-picked-up-report] ${pdf.count} orders; email ${email.filter((e) => e.ok).length}/${email.length}, whatsapp ${whatsapp.filter((w) => w.ok).length}/${whatsapp.length}`);
    return json(200, { sent: true, ...summary, email, whatsapp });
  } catch (e) {
    console.error('[not-picked-up-report]', e);
    return json(500, { error: e.message });
  }
};
