/**
 * Netlify Function: signup-email
 * POST /.netlify/functions/signup-email
 *
 * Creates a Supabase signup/login confirmation link without using Supabase's
 * built-in email sender, then sends that link through Resend. This avoids the
 * low default Supabase SMTP rate limit.
 */

const { createClient } = require('@supabase/supabase-js');

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

async function sendEmail({ to, name, actionLink, isExisting }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not configured.');

  const firstName = clean(name || 'reader', 80).split(' ')[0] || 'reader';
  const subject = isExisting
    ? 'Confirm your Ink & Chai email'
    : 'Confirm your Ink & Chai account';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#2a2018;background:#faf7f2;">
      <h2 style="font-family:Georgia,serif;font-weight:400;color:#8a6a1f;margin:0 0 12px;">Ink &amp; Chai</h2>
      <p>Hi ${esc(firstName)},</p>
      <p>${isExisting
        ? 'Please confirm this email address for your Ink &amp; Chai account.'
        : 'Please confirm your email address to activate your Ink &amp; Chai account.'}</p>
      <p style="margin:26px 0;">
        <a href="${esc(actionLink)}"
           style="background:#8a6a1f;color:#fff;text-decoration:none;padding:13px 20px;display:inline-block;letter-spacing:0.08em;text-transform:uppercase;font-size:12px;">
          ${isExisting ? 'Confirm email' : 'Confirm account'}
        </a>
      </p>
      <p style="font-size:13px;line-height:1.6;color:#5a4a38;">If the button does not work, copy and paste this link into your browser:<br>
        <a href="${esc(actionLink)}" style="color:#8a6a1f;word-break:break-all;">${esc(actionLink)}</a>
      </p>
      <p style="font-size:12px;line-height:1.6;color:#8a7a62;margin-top:28px;">Ink &amp; Chai · inkandchai.in</p>
    </div>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Ink & Chai <support@inkandchai.in>',
      to,
      subject,
      html,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.message || body.error || `Email send failed with ${res.status}`);
  }
  return body;
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

    await sendEmail({ to: email, name, actionLink, isExisting });

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
