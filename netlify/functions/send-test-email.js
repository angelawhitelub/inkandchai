/**
 * Netlify Function: send-test-email
 * POST /.netlify/functions/send-test-email   { to? }
 *
 * Admin — sends one test email (to `to`, or STORE_OWNER_EMAIL) and reports which
 * provider delivered it, so you can verify Mailjet/Resend/Brevo failover after
 * changing env vars WITHOUT placing a real order.
 *
 * Headers: X-Admin-Token / X-Admin-Key.
 */

const { requireAdmin } = require('./utils/admin-auth');
const { sendEmail }    = require('./utils/email');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Admin-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* defaults */ }

  const to = String(body.to || process.env.STORE_OWNER_EMAIL || '').trim();
  if (!to) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No recipient — pass { to } or set STORE_OWNER_EMAIL' }) };
  }

  const order = process.env.EMAIL_PROVIDER_ORDER || 'resend,brevo,mailjet';
  const configured = {
    resend:  !!process.env.RESEND_API_KEY,
    brevo:   !!process.env.BREVO_API_KEY,
    mailjet: !!(process.env.MAILJET_API_KEY && process.env.MAILJET_SECRET_KEY),
  };

  const stamp = new Date().toISOString();
  const result = await sendEmail({
    to,
    subject: `✅ Ink & Chai email test — ${stamp}`,
    html: `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:24px;background:#0d0b08;color:#f0e8d8;">
      <h2 style="color:#c9a84c;font-weight:400;">Email is working ✅</h2>
      <p style="color:#a09080;line-height:1.7;">This is a test from your admin panel. If you received it, transactional email is flowing again.</p>
      <p style="color:#7a6330;font-size:12px;">Sent ${stamp}</p>
    </div>`,
  });

  return {
    statusCode: result.ok ? 200 : 502,
    headers: CORS,
    body: JSON.stringify({
      success: !!result.ok,
      sent_to: to,
      delivered_via: result.provider || null,   // which provider succeeded
      provider_order: order,
      configured,                                 // which providers have keys set
      error: result.error || null,
    }),
  };
};
