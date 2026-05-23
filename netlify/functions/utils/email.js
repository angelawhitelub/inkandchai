/**
 * Shared sendEmail utility
 *
 * Provider priority (first key found in env wins):
 *   1. Brevo  — BREVO_API_KEY   (free: 300/day, 9k/month)
 *   2. Resend — RESEND_API_KEY  (free: 100/day, 3k/month — kept as fallback)
 *
 * To switch providers: set/unset the env vars in Netlify dashboard.
 * No code changes needed.
 */

const FROM_NAME  = 'Ink & Chai';
const FROM_EMAIL = 'support@inkandchai.in';

async function sendViaBrevo(key, { to, subject, html }) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender:      { name: FROM_NAME, email: FROM_EMAIL },
      to:          [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${data?.message || JSON.stringify(data)}`);
  console.log('Email sent via Brevo:', data?.messageId, '→', to);
}

async function sendViaResend(key, { to, subject, html }) {
  async function attempt(from) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  let r = await attempt(`${FROM_NAME} <${FROM_EMAIL}>`);
  if (r.ok) { console.log('Email sent via Resend (custom):', r.data.id, '→', to); return; }
  console.error(`Resend custom-domain error ${r.status}:`, JSON.stringify(r.data));

  // Fall back to onboarding sender if domain not verified
  const isDomainErr = r.status === 403 || /domain|verified|not.*allowed|testing/i.test(r.data?.message || '');
  if (isDomainErr) {
    r = await attempt(`${FROM_NAME} <onboarding@resend.dev>`);
    if (r.ok) { console.log('Email sent via Resend (fallback):', r.data.id, '→', to); return; }
    throw new Error(`Resend fallback error ${r.status}: ${JSON.stringify(r.data)}`);
  }
  throw new Error(`Resend error ${r.status}: ${JSON.stringify(r.data)}`);
}

/**
 * Send a transactional email. Non-fatal — logs errors but never throws.
 * Always returns { ok: boolean } so callers can check success.
 * @param {{ to: string, subject: string, html: string }} opts
 * @returns {{ ok: boolean }}
 */
async function sendEmail({ to, subject, html }) {
  if (!to)      { console.warn('sendEmail: empty "to" — skipped'); return { ok: false }; }
  if (!subject) { console.warn('sendEmail: empty subject — skipped'); return { ok: false }; }

  const resendKey = process.env.RESEND_API_KEY;
  const brevoKey  = process.env.BREVO_API_KEY;

  // Try Resend first
  if (resendKey) {
    try {
      await sendViaResend(resendKey, { to, subject, html });
      return { ok: true };
    } catch (err) {
      console.error('Resend failed, trying Brevo fallback:', err.message);
      // Fall through to Brevo
    }
  }

  // Brevo fallback (also used when RESEND_API_KEY not set)
  if (brevoKey) {
    try {
      await sendViaBrevo(brevoKey, { to, subject, html });
      return { ok: true };
    } catch (err) {
      console.error('Brevo also failed:', err.message);
    }
    return { ok: false };
  }

  console.warn('No email provider configured (set RESEND_API_KEY or BREVO_API_KEY)');
  return { ok: false };
}

module.exports = { sendEmail };
