/**
 * Netlify Function: signup-email
 * POST /.netlify/functions/signup-email
 *
 * Creates a Supabase signup/login confirmation link without using Supabase's
 * built-in email sender, then sends that link through Resend. This avoids the
 * low default Supabase SMTP rate limit.
 */

const { createClient } = require('@supabase/supabase-js');

const { sendEmail } = require('./utils/email');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function clean(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}


exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase server keys are not configured.' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const email = clean(body.email, 240).toLowerCase();
    const password = String(body.password || '');
    const name = clean(body.name, 120);
    const phone = clean(body.phone, 40);
    const redirectTo = clean(body.redirectTo, 500) || 'https://inkandchai.in/';

    if (!validEmail(email)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Please enter a valid email address.' }) };
    }
    if (!password || password.length < 6) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Password must be at least 6 characters.' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    let isExisting = false;
    let generated = await supabase.auth.admin.generateLink({
      type: 'signup',
      email,
      password,
      options: {
        redirectTo,
        data: { name, full_name: name, phone },
      },
    });

    if (generated.error && /registered|already|exists/i.test(generated.error.message || '')) {
      isExisting = true;
      generated = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email,
        options: { redirectTo },
      });
    }

    if (generated.error) throw generated.error;

    const actionLink = generated.data?.properties?.action_link;
    if (!actionLink) throw new Error('Supabase did not return a confirmation link.');

    const greeting   = name ? `Hi ${esc(name)},` : 'Hi there,';
    const subject    = isExisting ? 'Sign in to Ink & Chai' : 'Confirm your Ink & Chai account';
    const headline   = isExisting ? 'Sign in to your account' : 'Confirm your account';
    const bodyText   = isExisting
      ? 'Click the button below to sign in. This link expires in 1 hour.'
      : 'Click the button below to confirm your email and activate your Ink & Chai account.';
    const btnLabel   = isExisting ? 'Sign In' : 'Confirm Account';

    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:40px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#1c1916;border-radius:4px;overflow:hidden;max-width:520px;width:100%;">
        <!-- Header -->
        <tr>
          <td align="center" style="padding:32px 40px 24px;border-bottom:1px solid rgba(201,168,76,0.2);">
            <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#c9a84c;margin-bottom:6px;">Ink &amp; Chai</div>
            <div style="font-family:Georgia,serif;font-size:22px;font-weight:300;color:#faf7f2;">${esc(headline)}</div>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px 40px;color:#c8bfb0;font-size:15px;line-height:1.7;">
            <p style="margin:0 0 20px;">${greeting}</p>
            <p style="margin:0 0 28px;">${bodyText}</p>
            <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
              <tr>
                <td align="center" style="background:#c9a84c;border-radius:3px;">
                  <a href="${esc(actionLink)}" target="_blank"
                     style="display:inline-block;padding:14px 36px;font-size:13px;font-weight:600;
                            letter-spacing:2px;text-transform:uppercase;color:#0d0b08;text-decoration:none;">
                    ${btnLabel} →
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 8px;font-size:12px;color:#7a6e62;">Or copy this link into your browser:</p>
            <p style="margin:0;font-size:11px;color:#7a6e62;word-break:break-all;">${esc(actionLink)}</p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:20px 40px 28px;border-top:1px solid rgba(201,168,76,0.12);
                     font-size:11px;color:#5a5048;text-align:center;line-height:1.6;">
            This link expires in 1 hour. If you didn't request this, ignore this email.<br>
            &copy; Ink &amp; Chai &nbsp;|&nbsp; <a href="https://inkandchai.in" style="color:#c9a84c;text-decoration:none;">inkandchai.in</a>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const emailResult = await sendEmail({ to: email, subject, html });
    if (!emailResult.ok) {
      console.error('sendEmail returned ok:false for', email);
      // Still continue — Supabase link was generated; log for debugging
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        mode: isExisting ? 'email_confirmation' : 'signup_confirmation',
        message: isExisting
          ? 'Email confirmation link sent. Please check your inbox and spam.'
          : 'Confirmation email sent. Please check your inbox and spam.',
      }),
    };
  } catch (err) {
    console.error('signup-email error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message || 'Could not send signup email.' }),
    };
  }
};
