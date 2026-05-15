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
 */
async function sendWhatsApp({ to, template, params = [], lang = 'en' }) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) { console.warn('WHATSAPP_TOKEN not set — WA skipped'); return; }

  const phone = normalizePhone(to);
  if (!phone) { console.warn('sendWhatsApp: invalid phone', to); return; }

  const bodyParams = params.map(p => ({ type: 'text', text: String(p) }));

  const payload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: template,
      language: { code: lang },
      ...(bodyParams.length > 0 && {
        components: [{ type: 'body', parameters: bodyParams }],
      }),
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
    } else {
      console.log(`WhatsApp sent [${template}] → ${phone}`, data?.messages?.[0]?.id || '');
    }
  } catch (err) {
    console.error('sendWhatsApp exception:', err.message);
  }
}

module.exports = { sendWhatsApp, normalizePhone };
