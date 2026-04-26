/**
 * Netlify Function: auto-login-token
 * POST /.netlify/functions/auto-login-token
 *
 * Creates or finds a Supabase user for the given email (using admin API),
 * generates a magic-link token, and returns it to the client so the browser
 * can exchange it for a real session — no email click required.
 */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { email, name, phone } = body;
  if (!email) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'email required' }) };

  const SUPABASE_URL         = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Generate a magic-link token — does NOT send any email (we handle email separately)
    const { data, error } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: {
        data:       { name: name || '', phone: phone || '' },
        redirectTo: 'https://inkandchai.in',
      },
    });

    if (error) throw error;

    // Upsert profile with name + phone if provided
    if (data.user && (name || phone)) {
      await supabase.from('profiles').upsert({
        id:    data.user.id,
        name:  name  || '',
        phone: phone || '',
      }, { onConflict: 'id', ignoreDuplicates: false });
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        token_hash: data.properties.hashed_token,
      }),
    };

  } catch (err) {
    console.error('auto-login-token error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
