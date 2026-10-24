/**
 * Scheduled: rto-reship-offer-scheduled
 *
 * Hourly, sending only 09:00-21:00 IST (jobs.toml): WhatsApps each prepaid
 * customer whose order the courier has just marked RTO, once, asking whether
 * they still want the books (free re-shipment) or a refund. Their reply is
 * handled in code by the WhatsApp bot, and the RTO refund job holds the refund
 * for 48 h after the parcel is back unless they answer. Rules and states:
 * utils/rto-reship.js.
 *
 * Sends nothing until WHATSAPP_RTO_RESHIP_TEMPLATE names an approved template.
 * Over HTTP (owner only) it is always a preview of who would be messaged.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const reship = require('./utils/rto-reship');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
/** 09:00-20:59 IST: no customer is woken by it; a night RTO waits for morning. */
function daytimeIST(now = Date.now()) {
  const h = new Date(now + 330 * 60000).getUTCHours();
  return h >= 9 && h < 21;
}
const json = (statusCode, body) => ({ statusCode, headers: { ...CORS, 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

exports.handler = async (event = {}) => {
  const fromCron = !event.rawUrl;
  if (!fromCron) {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
    const blocked = requireAdmin(event, CORS);
    if (blocked) return blocked;
  }
  const dryRun = !fromCron;
  if (!dryRun && !reship.offerTemplate()) {
    console.log('[rto-reship-offer] skipped: WHATSAPP_RTO_RESHIP_TEMPLATE is not set');
    return json(200, { ok: true, enabled: false });
  }
  if (!dryRun && !daytimeIST()) return json(200, { ok: true, skipped: 'outside 09:00-21:00 IST' });
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { sendWhatsApp } = require('./utils/whatsapp');
    const { isOptedOut } = require('./utils/bot-optout');
    const summary = await reship.sendOffers({ supabase, send: sendWhatsApp, isOptedOut }, { dryRun });
    console.log(`[rto-reship-offer] ${dryRun ? 'preview' : 'run'} sent=${summary.sent.length} would_send=${summary.would_send.length} failed=${summary.failed.length} skipped=${summary.skipped.length}${summary.error ? ` error=${summary.error}` : ''}`);
    return json(200, { ok: true, ...summary });
  } catch (e) {
    console.error('[rto-reship-offer]', e);
    return json(500, { ok: false, error: e.message });
  }
};

exports.__test = { daytimeIST };
