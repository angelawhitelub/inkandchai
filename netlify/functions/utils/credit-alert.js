/**
 * "Your OpenAI credits have run out" -- email to the owner the moment the bot
 * hits OpenAI's quota error (owner, 25 Nov 2026: the balance often reaches zero
 * and nobody notices until customers go unanswered).
 *
 * At most one email per THROTTLE_HOURS (KV catalog:credit-alert:<service>), so
 * a busy hour of failed replies is one email, not hundreds. While credits are
 * out the bot cannot answer; those chats go to the Bot Inbox agent queue.
 */
'use strict';

const THROTTLE_HOURS = 3;
// OpenAI's codes for "no money left", as opposed to a short rate limit.
const QUOTA_CODES = new Set(['insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active', 'access_terminated']);

/** Is this OpenAI error response "out of credits" (not a passing rate limit)? */
function isOpenAIQuota(status, data) {
  const err = (data && data.error) || {};
  if (QUOTA_CODES.has(String(err.code || '')) || QUOTA_CODES.has(String(err.type || ''))) return true;
  return (status === 429 || status === 402) && /quota|billing|credit/i.test(String(err.message || ''));
}

function store(deps) {
  if (deps.store) return deps.store;
  const { getStore } = require('@netlify/blobs');
  return getStore('catalog');
}

/**
 * Email the owner, unless one went out in the last THROTTLE_HOURS.
 * @returns {Promise<'sent'|'throttled'|'no-recipient'|'failed'>}
 */
async function notifyOutOfCredits(service = 'OpenAI', detail = '', deps = {}) {
  const to = deps.to || process.env.CREDIT_ALERT_EMAIL || process.env.STORE_OWNER_EMAIL;
  if (!to) return 'no-recipient';
  const key = `credit-alert:${service.toLowerCase()}`;
  const now = deps.now || Date.now();
  try {
    const last = await store(deps).get(key, { type: 'json' });
    if (last && now - Date.parse(last.at) < THROTTLE_HOURS * 3600e3) return 'throttled';
    // Mark first: two replies failing at the same moment send one email.
    await store(deps).setJSON(key, { at: new Date(now).toISOString() });
  } catch (e) {
    console.warn('[credit-alert] throttle store unreadable, sending anyway:', e.message);
  }
  const when = new Date(now).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  try {
    const send = deps.sendEmail || require('./email').sendEmail;
    const r = await send({
      to,
      subject: `⚠️ ${service} credits have run out — the WhatsApp bot cannot reply`,
      html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#2b2118;max-width:560px">
  <p><strong>${esc(service)} refused a request at ${esc(when)} IST because the account is out of credits.</strong></p>
  <p>Until you add credits, the WhatsApp and Instagram bot cannot answer customers. Their chats are being put in <strong>Bot Inbox → Agent queue</strong> so you can reply by hand.</p>
  <p>Add credits: <a href="https://platform.openai.com/settings/organization/billing/overview">platform.openai.com → Billing</a></p>
  ${detail ? `<p style="color:#6b5a48;font-size:12px">OpenAI said: ${esc(String(detail).slice(0, 300))}</p>` : ''}
  <p style="color:#6b5a48;font-size:12px">You get at most one of these every ${THROTTLE_HOURS} hours while it lasts.</p>
</div>`,
    });
    return r && r.ok === false ? 'failed' : 'sent';
  } catch (e) {
    console.error('[credit-alert] email failed:', e.message);
    return 'failed';
  }
}

module.exports = { isOpenAIQuota, notifyOutOfCredits, THROTTLE_HOURS };
