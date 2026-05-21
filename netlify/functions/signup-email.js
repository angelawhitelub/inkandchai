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
