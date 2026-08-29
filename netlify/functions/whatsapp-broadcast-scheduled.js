/**
 * Scheduled personalized WhatsApp engagement campaign.
 * Netlify invokes this at 7:00 PM IST every Tuesday and Friday.
 *
 * Required before enabling:
 *   1. Apply sql/whatsapp_campaign_deliveries.sql.
 *   2. Approve a Meta marketing template with an image header, four body
 *      variables, and a dynamic URL button whose base is
 *      https://inkandchai.in/product/{{1}}.
 *   3. Set WHATSAPP_BROADCAST_TEMPLATE to that template name.
 *
 * The short scheduler enqueues whatsapp-broadcast-run-background, keeping the
 * full send outside the scheduled-function response window. If configuration
 * is absent, it safely skips instead of contacting customers unexpectedly.
 */

exports.handler = async () => {
  const template = String(process.env.WHATSAPP_BROADCAST_TEMPLATE || '').trim();
  const adminSecret = String(process.env.ADMIN_SECRET || '').trim();
  const siteUrl = String(process.env.URL || '').replace(/\/+$/, '');
  if (!template || !adminSecret || !siteUrl) {
    console.warn('[broadcast-scheduled] skipped: WHATSAPP_BROADCAST_TEMPLATE, ADMIN_SECRET, or URL is missing');
    return { statusCode:200, body:JSON.stringify({ skipped:true, reason:'automation not configured' }) };
  }

  const now = new Date();
  const istDate = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit',
  }).format(now);
  const campaignKey = `recommendations-${istDate}`;

  const response = await fetch(`${siteUrl}/.netlify/functions/whatsapp-broadcast-run-background`, {
    method:'POST',
    headers:{ 'content-type':'application/json', 'x-admin-key':adminSecret },
    body:JSON.stringify({
      template,
      days_back:Number(process.env.WHATSAPP_BROADCAST_DAYS_BACK) || 365,
      limit:Number(process.env.WHATSAPP_BROADCAST_LIMIT) || 100,
      cooldown_days:Number(process.env.WHATSAPP_BROADCAST_COOLDOWN_DAYS) || 14,
      lang:process.env.WHATSAPP_BROADCAST_LANG || 'en',
      personalized:true,
      segment_by:'auto',
      rich_media:true,
      require_opt_in:true,
      source:'scheduled',
      campaign_key:campaignKey,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Unable to enqueue WhatsApp campaign (${response.status}): ${detail.slice(0, 500)}`);
  }
  return { statusCode:200, body:JSON.stringify({ queued:true, campaign_key:campaignKey }) };
};
