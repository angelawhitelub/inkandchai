/**
 * One-off WhatsApp campaign, fired at 20:00 IST on a single named date.
 *
 * The regular campaign (whatsapp-broadcast-scheduled) runs Tue/Fri at 19:00 IST
 * and is the right home for anything recurring. This exists for a send that was
 * asked for on a specific evening — here, recently DELIVERED customers, first
 * 100, consent not required.
 *
 * IT CANNOT REPEAT. Netlify cron has no one-shot form, so this is registered
 * daily at 14:30 UTC and gates on WHATSAPP_BROADCAST_ONEOFF_DATE: unless that
 * variable holds today's IST date, it returns without contacting anyone. To use
 * it again, set the variable to the new date — never edit the schedule.
 *
 * Sending without recorded consent is still bounded by the ledger-counted
 * WHATSAPP_BROADCAST_PILOT_CAP in whatsapp-broadcast.js, so this cannot walk
 * through the whole customer list even if the date is left set by mistake.
 */

const HEADERS = { 'Content-Type': 'application/json' };

exports.handler = async () => {
  const template = String(process.env.WHATSAPP_BROADCAST_TEMPLATE || '').trim();
  const adminSecret = String(process.env.ADMIN_SECRET || '').trim();
  const siteUrl = String(process.env.URL || 'https://inkandchai.in').replace(/\/+$/, '');
  const armedFor = String(process.env.WHATSAPP_BROADCAST_ONEOFF_DATE || '').trim();

  const istDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  if (armedFor !== istDate) {
    console.log(`[broadcast-oneoff] not armed for today (armed=${armedFor || 'unset'}, today=${istDate}) — sending nothing`);
    return { statusCode: 200, body: JSON.stringify({ skipped: true, armed_for: armedFor || null, ist_date: istDate }) };
  }
  if (!template || !adminSecret) {
    console.error('[broadcast-oneoff] WHATSAPP_BROADCAST_TEMPLATE or ADMIN_SECRET is missing');
    return { statusCode: 500, body: JSON.stringify({ error: 'Campaign not configured' }) };
  }

  const response = await fetch(`${siteUrl}/.netlify/functions/whatsapp-broadcast-run-background`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': adminSecret },
    body: JSON.stringify({
      template,
      // Delivered only: this campaign recommends the next book, which only
      // lands once the last one is actually in the reader's hands.
      statuses: ['delivered'],
      days_back: Number(process.env.WHATSAPP_BROADCAST_ONEOFF_DAYS_BACK) || 90,
      limit: Number(process.env.WHATSAPP_BROADCAST_ONEOFF_LIMIT) || 100,
      cooldown_days: 14,
      lang: process.env.WHATSAPP_BROADCAST_LANG || 'en',
      personalized: true,
      segment_by: 'auto',
      rich_media: true,
      require_opt_in: false,
      source: 'scheduled',
      campaign_key: `oneoff-delivered-${istDate}`,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Unable to enqueue one-off campaign (${response.status}): ${detail.slice(0, 500)}`);
  }
  console.log(`[broadcast-oneoff] queued for ${istDate}`);
  return { statusCode: 200, body: JSON.stringify({ queued: true, campaign_key: `oneoff-delivered-${istDate}` }) };
};
