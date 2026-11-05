/**
 * Scheduled: delivery-failed-ask-scheduled
 *
 * Hourly, sending only 09:00-21:00 IST: WhatsApps each customer whose delivery the
 * courier has just reported failed, once, asking whether they still want the order.
 * Their replies are handled in code by the WhatsApp bot and kept on the order for
 * the owner. Rules and states: utils/delivery-failed-ask.js.
 *
 * Sends nothing until WHATSAPP_DELIVERY_FAILED_TEMPLATE names an approved template.
 * Over HTTP (owner only) it is always a preview of who would be messaged.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const ask = require('./utils/delivery-failed-ask');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: { ...CORS, 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

function daytimeIST(now = Date.now()) {
  const h = new Date(now + 330 * 60000).getUTCHours();
  return h >= 9 && h < 21;
}

exports.handler = async (event = {}) => {
  const fromCron = !event.rawUrl;
  if (!fromCron) {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
    const blocked = requireAdmin(event, CORS);
    if (blocked) return blocked;
  }
  const dryRun = !fromCron;
  if (!dryRun && !ask.askTemplate()) return json(200, { ok: true, enabled: false });
  if (!dryRun && !daytimeIST()) return json(200, { ok: true, skipped: 'outside 09:00-21:00 IST' });
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { sendWhatsApp, normalizePhone } = require('./utils/whatsapp');
    const { isOptedOut } = require('./utils/bot-optout');
    // So the Bot Inbox thread and the bot's own history show what was asked.
    const logMessage = async (phone, message) => {
      await supabase.from('bot_messages').insert({
        customer_phone: normalizePhone(phone), role: 'bot', message, created_at: new Date().toISOString(),
      });
    };
    const summary = await ask.sendAsks({ supabase, send: sendWhatsApp, isOptedOut, logMessage }, { dryRun });
    console.log(`[delivery-failed-ask] ${dryRun ? 'preview' : 'run'} sent=${summary.sent.length} would_send=${summary.would_send.length} failed=${summary.failed.length} skipped=${summary.skipped.length}`);
    return json(200, { ok: true, ...summary });
  } catch (e) {
    console.error('[delivery-failed-ask]', e);
    return json(500, { ok: false, error: e.message });
  }
};

exports.__test = { daytimeIST };
