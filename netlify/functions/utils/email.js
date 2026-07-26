/**
 * Shared sendEmail utility — multi-provider with automatic failover.
 *
 * Providers (each tried in order until one succeeds):
 *   • Resend  — RESEND_API_KEY                       (free: 100/day, 3k/month)
 *   • Brevo   — BREVO_API_KEY                         (free: 300/day, 9k/month)
 *   • Mailjet — MAILJET_API_KEY + MAILJET_SECRET_KEY  (free: 200/day, 6k/month)
 *
 * Default order: resend → brevo → mailjet. Override WITHOUT a redeploy by
 * setting EMAIL_PROVIDER_ORDER in Netlify, e.g. "mailjet,resend,brevo" — handy
 * when one provider's monthly quota is exhausted and you want a fresh one first
 * (avoids wasting a failed API call on the dead provider before every send).
 *
 * Set/unset the relevant env vars in the Netlify dashboard. No code changes needed.
 */

const FROM_NAME  = 'Ink & Chai';
const FROM_EMAIL = 'support@inkandchai.in';

// Attachments arrive as [{ filename, content, contentType? }] where `content`
// is a Buffer or a raw string; every provider wants base64, so normalise once.
function normalizeAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .filter(a => a && a.filename && a.content != null)
    .map(a => ({
      filename: a.filename,
      contentType: a.contentType || 'application/octet-stream',
      base64: Buffer.isBuffer(a.content)
        ? a.content.toString('base64')
        : Buffer.from(String(a.content), 'utf8').toString('base64'),
    }));
}

async function sendViaBrevo(key, { to, subject, html, attachments }) {
  const atts = normalizeAttachments(attachments);
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender:      { name: FROM_NAME, email: FROM_EMAIL },
      to:          [{ email: to }],
      subject,
      htmlContent: html,
      ...(atts.length ? { attachment: atts.map(a => ({ name: a.filename, content: a.base64 })) } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${data?.message || JSON.stringify(data)}`);
  console.log('Email sent via Brevo:', data?.messageId, '→', to);
}

async function sendViaResend(key, { to, subject, html, attachments }) {
  const atts = normalizeAttachments(attachments);
  async function attempt(from) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to, subject, html,
        ...(atts.length ? { attachments: atts.map(a => ({ filename: a.filename, content: a.base64 })) } : {}),
      }),
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

async function sendViaMailjet(pub, priv, { to, subject, html, attachments }) {
  const atts = normalizeAttachments(attachments);
  const auth = Buffer.from(`${pub}:${priv}`).toString('base64');
  const res = await fetch('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Messages: [{
        From:     { Email: FROM_EMAIL, Name: FROM_NAME },
        To:       [{ Email: to }],
        Subject:  subject,
        HTMLPart: html,
        ...(atts.length ? { Attachments: atts.map(a => ({ ContentType: a.contentType, Filename: a.filename, Base64Content: a.base64 })) } : {}),
      }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  const msg = Array.isArray(data?.Messages) ? data.Messages[0] : null;
  if (!res.ok || (msg && msg.Status && msg.Status !== 'success')) {
    throw new Error(`Mailjet ${res.status}: ${msg?.Errors ? JSON.stringify(msg.Errors) : (data?.ErrorMessage || JSON.stringify(data))}`);
  }
  console.log('Email sent via Mailjet →', to);
}

/**
 * Send a transactional email. Non-fatal — logs errors but never throws.
 * Always returns { ok: boolean } so callers can check success.
 * @param {{ to: string, subject: string, html: string, attachments?: Array<{filename:string, content:(Buffer|string), contentType?:string}> }} opts
 * @returns {{ ok: boolean }}
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function sendEmail({ to, subject, html, attachments }) {
  if (!to)              { console.warn('sendEmail: empty "to" — skipped'); return { ok: false }; }
  if (!EMAIL_RE.test(to)) { console.warn(`sendEmail: invalid address "${to}" — skipped`); return { ok: false }; }
  if (!subject)         { console.warn('sendEmail: empty subject — skipped'); return { ok: false }; }

  // Each provider is only attempted if its env keys are present.
  const providers = {
    resend:  process.env.RESEND_API_KEY
      ? () => sendViaResend(process.env.RESEND_API_KEY, { to, subject, html, attachments })
      : null,
    brevo:   process.env.BREVO_API_KEY
      ? () => sendViaBrevo(process.env.BREVO_API_KEY, { to, subject, html, attachments })
      : null,
    mailjet: (process.env.MAILJET_API_KEY && process.env.MAILJET_SECRET_KEY)
      ? () => sendViaMailjet(process.env.MAILJET_API_KEY, process.env.MAILJET_SECRET_KEY, { to, subject, html, attachments })
      : null,
  };

  // Order: EMAIL_PROVIDER_ORDER env override, else resend → brevo → mailjet.
  const order = (process.env.EMAIL_PROVIDER_ORDER || 'resend,brevo,mailjet')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  let attempted = false;
  const errors = [];
  for (const name of order) {
    const send = providers[name];
    if (!send) continue;                 // not configured — skip
    attempted = true;
    try {
      await send();
      return { ok: true, provider: name };
    } catch (err) {
      console.error(`Email via ${name} failed, trying next provider:`, err.message);
      errors.push(`${name}: ${err.message}`);
    }
  }

  if (!attempted) console.warn('No email provider configured (set RESEND_API_KEY, BREVO_API_KEY, or MAILJET_API_KEY + MAILJET_SECRET_KEY)');
  else console.error('All configured email providers failed for →', to);
  return { ok: false, error: attempted ? errors.join(' | ') : 'no provider configured' };
}

module.exports = { sendEmail };
