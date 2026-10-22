/**
 * WhatsApps the packing team a courier's sorted label PDF -- shared by
 * xpressbees-labels-send-scheduled.js and nimbuspost-labels-send-scheduled.js.
 *
 * Only labels NOT sent before go out. A label still waiting for the courier
 * the next morning is not sent again -- it was already packed, and a second
 * copy is how the same order gets packed twice.
 *
 * Internal only: it goes to the numbers below, never to a customer.
 *
 * Config (Worker secrets/vars):
 *   LABEL_PHONES    WhatsApp numbers, comma-separated. Empty: nothing is sent.
 *   LABEL_TEMPLATE  default packing_labels_pdf -- UTILITY, DOCUMENT header, body:
 *       Packing labels for {{1}}: {{2}} labels, {{3}} books. The pick list is on
 *       the first pages, then the labels in packing order. - Ink & Chai
 *     {{1}} is the day and the courier, e.g. "08 Oct (NimbusPost)".
 *     A business-started WhatsApp only reaches a number outside the 24-hour
 *     window through an approved template. Until it is approved the PDF goes
 *     as a plain document, which arrives only if that number messaged the
 *     business number in the last 24 hours.
 *
 * Sent AWBs are remembered in KV (ORDER_FALLBACK, one key per courier, 45
 * days) and only marked once at least one number actually received the PDF,
 * so a failed run is retried by the next one.
 *
 * The handler also takes an owner POST from the admin ("Send labels to team"):
 *   { dry_run?, all? }   dry_run says what would go and to whom; all=true
 *                        resends every ready label, sent before or not.
 */

const { requireAdmin } = require('./admin-auth');
const bindings = require('../../../worker/shims/runtime-bindings');
const { sendWhatsApp, sendDocument, sendText, uploadMedia, normalizePhone } = require('./whatsapp');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const KEEP_DAYS = 45;

const phones = () => [...new Set(String(process.env.LABEL_PHONES || '').split(/[,;]+/)
  .map((p) => normalizePhone(p.trim())).filter(Boolean))];

const istDay = (d = new Date()) => d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });

/** One number: the template with the PDF, else the PDF as a plain document. */
async function deliver(to, { mediaId, filename, template, params, caption }, wa) {
  const viaTemplate = await wa.sendWhatsApp({ to, template, params, headerDocument: { id: mediaId, filename } });
  if (viaTemplate.ok) return { to, ok: true, via: 'template' };
  const doc = await wa.sendDocument(to, { id: mediaId, filename, caption });
  if (doc.ok) return { to, ok: true, via: 'document' };
  const why = doc.data?.error?.message || doc.error || 'not delivered';
  return {
    to, ok: false,
    error: `template "${template}" not usable (${viaTemplate.data?.error?.message || viaTemplate.error || 'rejected'}) `
      + `and the plain PDF was refused (${why}) -- the number has not messaged us in 24 h`,
  };
}

/**
 * courier: { name: 'NimbusPost', slug: 'nimbuspost', sentKey, adminButton,
 *            labels: { run, istDate } }   (the admin-*-labels.js _test exports)
 */
function makeLabelSender(courier) {
  const tag = `[${courier.slug}-labels-send]`;
  const SENT_KEY = courier.sentKey;

  /** { awb: iso time sent } from KV, pruned. A KV fault reads as empty, never as "all sent". */
  async function readSent(kv) {
    if (!kv) return {};
    try {
      const raw = await kv.get(SENT_KEY);
      const all = raw ? JSON.parse(raw) : {};
      const cutoff = Date.now() - KEEP_DAYS * 86400e3;
      return Object.fromEntries(Object.entries(all).filter(([, at]) => Date.parse(at) > cutoff));
    } catch (e) {
      console.warn(tag, 'sent list unreadable:', e.message);
      return {};
    }
  }

  async function markSent(kv, sent, awbs) {
    if (!kv) return false;
    const at = new Date().toISOString();
    for (const a of awbs) sent[a] = at;
    await kv.put(SENT_KEY, JSON.stringify(sent), { expirationTtl: KEEP_DAYS * 86400 });
    return true;
  }

  /** deps.courier: the courier's own test doubles, passed through to labels.run. */
  async function sendLabels({ dryRun = false, all = false } = {}, deps = {}) {
    const kv = 'kv' in deps ? deps.kv : bindings.get('ORDER_FALLBACK');
    const wa = deps.wa || { sendWhatsApp, sendDocument, uploadMedia };
    const to = deps.phones || phones();
    const template = process.env.LABEL_TEMPLATE || 'packing_labels_pdf';
    if (!to.length) return { sent: false, reason: 'LABEL_PHONES is not set' };

    const sent = await readSent(kv);
    const only = all ? null : (awb) => !sent[awb];
    if (dryRun) {
      const out = await courier.labels.run({ summaryOnly: true, only }, deps.courier || {});
      return { dry_run: true, ready: out.ready.length, new_labels: out.awbs.length, already_sent: out.ready.length - out.awbs.length, would_whatsapp: to, template };
    }
    const out = await courier.labels.run({ only }, deps.courier || {});
    if (!out.awbs.length) return { sent: false, reason: 'no new labels', ready: out.ready.length };

    const s = out.summary;
    const day = `${istDay()} (${courier.name})`;
    const filename = `${courier.slug}_labels_${s.labels}_sorted_${courier.labels.istDate()}.pdf`;
    const media = await wa.uploadMedia(out.pdf, { mime: 'application/pdf', filename });
    if (!media.ok) throw new Error(`WhatsApp media upload failed: ${media.data?.error?.message || media.error || media.status}`);

    const params = [day, s.labels, s.units];
    const caption = `Packing labels for ${day}: ${s.labels} labels, ${s.units} books. Pick list first, then the labels in packing order. - Ink & Chai`;
    const whatsapp = [];
    for (const phone of to) whatsapp.push(await deliver(phone, { mediaId: media.id, filename, template, params, caption }, wa));

    // Only a delivered PDF counts as sent; otherwise the next run tries again.
    let marked = false;
    if (whatsapp.some((w) => w.ok)) {
      try { marked = await markSent(kv, sent, out.awbs); } catch (e) { console.warn(tag, 'mark sent:', e.message); }
    }
    return {
      sent: whatsapp.some((w) => w.ok), labels: s.labels, units: s.units, mixed: s.mixed,
      unread: s.unread.length, ready: out.ready.length, marked, whatsapp,
    };
  }

  async function handler(event = {}) {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
    const fromCron = !!(event.headers && event.headers['x-cloudflare-cron']);
    if (!fromCron) { const block = requireAdmin(event, CORS); if (block) return block; }
    let body = {};
    try { body = JSON.parse(event.body || '{}') || {}; } catch { body = {}; }
    try {
      const r = await sendLabels(fromCron ? {} : { dryRun: body.dry_run === true, all: body.all === true });
      console.log(tag, JSON.stringify(r));
      if (fromCron && r.sent === false && r.whatsapp && process.env.STORE_OWNER_PHONE) {
        await sendText(process.env.STORE_OWNER_PHONE, `⚠️ ${courier.name} labels (${r.labels}) were NOT delivered to the packing team on WhatsApp.\n${r.whatsapp.map((w) => w.error).filter(Boolean)[0] || ''}\nDownload them from Admin → Unshipped → ${courier.adminButton}.`).catch(() => {});
      }
      return json(200, r);
    } catch (e) {
      console.error(tag, e);
      if (fromCron && process.env.STORE_OWNER_PHONE) {
        await sendText(process.env.STORE_OWNER_PHONE, `⚠️ ${courier.name} labels send failed: ${e.message}`).catch(() => {});
      }
      return json(500, { error: e.message });
    }
  }

  return { handler, sendLabels, readSent, markSent, SENT_KEY };
}

module.exports = { makeLabelSender, deliver };
