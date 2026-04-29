/**
 * Netlify Function: test-email
 * GET  /.netlify/functions/test-email?to=customer@example.com
 *
 * Diagnostic endpoint — sends a test email and returns the FULL Resend response
 * so you can see exactly what's failing (domain not verified, key wrong, etc.).
 *
 * SAFETY: requires ?key=<RESEND_API_KEY> so randoms can't spam through it.
 */

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const to     = params.to || '';
  const key    = process.env.RESEND_API_KEY;

  // Tiny auth — caller must know the key (or use admin pass)
  if (params.key !== key && params.key !== process.env.ADMIN_PASS) {
    return { statusCode: 401, body: JSON.stringify({ error: 'pass ?key=<RESEND_API_KEY> or ADMIN_PASS in querystring' }) };
  }

  const diag = {
    env_check: {
      RESEND_API_KEY:      key ? `set (${key.slice(0,7)}…)` : '❌ MISSING',
      STORE_OWNER_EMAIL:   process.env.STORE_OWNER_EMAIL || '❌ MISSING',
      SUPABASE_URL:        process.env.SUPABASE_URL ? 'set' : '❌ MISSING',
      RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET ? 'set' : '❌ MISSING',
    },
    from_attempted: 'Ink & Chai <support@inkandchai.in>',
    to,
  };

  if (!key) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...diag, error: 'RESEND_API_KEY env var not set in Netlify' }, null, 2) };
  }
  if (!to) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...diag, error: 'pass ?to=email@example.com' }, null, 2) };
  }

  // Try sending from the custom domain
  let custom_result;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Ink & Chai <support@inkandchai.in>',
        to,
        subject: '✅ Ink & Chai — test email (custom domain)',
        html: `<p>If you got this, your <b>inkandchai.in</b> domain is verified in Resend and customer emails will work.</p><p>Sent at ${new Date().toISOString()}</p>`,
      }),
    });
    custom_result = { status: r.status, body: await r.json() };
  } catch (e) {
    custom_result = { error: e.message };
  }

  // Try the onboarding fallback (always works without verification, but only TO the account owner)
  let fallback_result;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Ink & Chai <onboarding@resend.dev>',
        to,
        subject: '✅ Ink & Chai — test email (onboarding fallback)',
        html: `<p>This came from <b>onboarding@resend.dev</b> (Resend's default sender, no domain verification needed).</p><p>If only THIS arrives but the custom-domain one didn't — your domain isn't verified yet.</p>`,
      }),
    });
    fallback_result = { status: r.status, body: await r.json() };
  } catch (e) {
    fallback_result = { error: e.message };
  }

  // Interpret the result
  let diagnosis = '';
  if (custom_result.status >= 200 && custom_result.status < 300) {
    diagnosis = '✅ Custom domain works! Customer emails should be sending fine. If they still aren\'t, check the customer.email field in your checkout flow.';
  } else if (custom_result.body?.message?.includes('domain') || custom_result.body?.message?.includes('verified') || custom_result.status === 403) {
    diagnosis = '❌ DOMAIN NOT VERIFIED IN RESEND. Go to https://resend.com/domains, add "inkandchai.in", add the DNS records (SPF/DKIM) to your domain registrar, wait ~10 min, then click Verify. Customer emails will start working immediately after.';
  } else if (custom_result.status === 401 || custom_result.status === 403) {
    diagnosis = '❌ API key invalid or revoked. Generate a new one at https://resend.com/api-keys and update RESEND_API_KEY in Netlify env vars.';
  } else if (custom_result.body?.message?.includes('testing emails to your own email')) {
    diagnosis = '❌ FREE TIER + UNVERIFIED DOMAIN: Resend only lets you send to YOUR OWN email until you verify your domain. Verify inkandchai.in at https://resend.com/domains.';
  } else {
    diagnosis = `❓ Unknown error: ${JSON.stringify(custom_result.body)}`;
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...diag, custom_domain: custom_result, onboarding_fallback: fallback_result, diagnosis }, null, 2),
  };
};
