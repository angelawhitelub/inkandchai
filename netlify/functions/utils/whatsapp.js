/**
 * WhatsApp Cloud API helper
 * Used by verify-payment, cod-order, update-order-status, send-abandoned-email
 *
 * Required env vars:
 *   WHATSAPP_TOKEN    — permanent system user token
 *   WHATSAPP_PHONE_ID — phone number ID (1188708014316574)
 */

const PHONE_ID = process.env.WHATSAPP_PHONE_ID || '1188708014316574';
const API_VERSION = 'v20.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}/${PHONE_ID}/messages`;

/** Strip non-digits and ensure 91 country code for Indian numbers */
function normalizePhone(phone) {
  if (!phone) return null;
  const p = String(phone).replace(/\D/g, '');
  if (p.length === 10) return '91' + p;
  if (p.length === 11 && p.startsWith('0')) return '91' + p.slice(1);
  if (p.length === 12 && p.startsWith('91')) return p;
  if (p.length > 10) return p; // international — use as-is
  return null;
}

/**
 * Send a WhatsApp template message.
 * Non-fatal — logs errors but never throws.
 *
 * @param {object} opts
 * @param {string} opts.to           - customer phone (any format)
 * @param {string} opts.template     - template name e.g. "order_confirmed"
 * @param {string[]} opts.params     - body variable values [{{1}}, {{2}}, ...]
 * @param {string} [opts.lang]       - language code, default "en"
 * @param {string} [opts.urlButtonParam] - dynamic-URL button suffix. Set this
 *        when the template has a URL button defined as "<base>/{{1}}"; the value
 *        is substituted for {{1}} (index 0 button). e.g. order id for a
 *        "https://inkandchai.in/track/?id={{1}}" tracking button.
 */
async function sendWhatsApp({ to, template, params = [], lang = 'en', urlButtonParam = null }) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) { console.warn('WHATSAPP_TOKEN not set — WA skipped'); return { ok: false, skipped: true }; }

  const phone = normalizePhone(to);
  if (!phone) { console.warn('sendWhatsApp: invalid phone', to); return { ok: false, skipped: true }; }

  // Meta rejects the entire send if a body parameter contains a newline, a tab,
  // or four-plus consecutive spaces — so one book title with a stray line break
  // would silently cost the customer their whole notification. Collapse runs of
  // whitespace to a single space for every template, not just the ones that
  // happen to interpolate free text today.
  const bodyParams = params.map(p => ({ type: 'text', text: String(p).replace(/\s+/g, ' ').trim() }));

  const components = [];
  if (bodyParams.length > 0) components.push({ type: 'body', parameters: bodyParams });
  if (urlButtonParam != null && String(urlButtonParam) !== '') {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(urlButtonParam) }],
    });
  }

  const payload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: template,
      language: { code: lang },
      ...(components.length > 0 && { components }),
    },
  };

  try {
    const res = await fetch(BASE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`WhatsApp API error ${res.status} [${template}] → ${phone}:`, JSON.stringify(data?.error || data));
      return { ok: false, status: res.status, data };
    }
    console.log(`WhatsApp sent [${template}] → ${phone}`, data?.messages?.[0]?.id || '');
    return { ok: true, status: res.status, data };
  } catch (err) {
    console.error('sendWhatsApp exception:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Send a free-form WhatsApp TEXT message (not a template). Only deliverable
 * inside the 24-hour customer-service window — fine for the store owner (who
 * chats with the bot) and for customers who just messaged. Never throws.
 */
async function sendText(to, text) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) { console.warn('WHATSAPP_TOKEN not set — WA text skipped'); return { ok: false, skipped: true }; }
  const phone = normalizePhone(to);
  if (!phone) { console.warn('sendText: invalid phone', to); return { ok: false, skipped: true }; }
  try {
    const res = await fetch(BASE_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: String(text).slice(0, 4096), preview_url: false },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`WhatsApp text error ${res.status} → ${phone}:`, JSON.stringify(data?.error || data));
      return { ok: false, status: res.status, data };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    console.error('sendText exception:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendWhatsApp, sendText, normalizePhone };
