/**
 * Netlify Function: check-cod-eligibility
 * POST /.netlify/functions/check-cod-eligibility   { phone, email }
 *
 * PUBLIC — the checkout calls this once it knows the customer's phone/email to
 * decide whether to offer Cash on Delivery. Returns { cod_blocked } true for
 * customers who previously refused a COD parcel (it went RTO). Read-only.
 *
 * This is a convenience for the UI only — the real enforcement lives in
 * cod-order / create-order / phonepe-create-order, which reject a COD or
 * partial-COD order server-side regardless of what the client sends.
 */

const { createClient } = require('@supabase/supabase-js');
const { codBlockedForCustomer, COD_BLOCKED_MESSAGE } = require('./utils/cod-risk');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  // Fail open if Supabase isn't configured — never block checkout on infra.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ cod_blocked: false }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* defaults */ }
  const phone = String(body.phone || '').trim();
  const email = String(body.email || '').trim();
  if (!phone && !email) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ cod_blocked: false }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const risk = await codBlockedForCustomer(supabase, { phone, email });
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        cod_blocked: !!risk.blocked,
        rto_count:   risk.rtoCount || 0,
        message:     risk.blocked ? COD_BLOCKED_MESSAGE : '',
      }),
    };
  } catch (err) {
    console.error('check-cod-eligibility error (failing open):', err.message);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ cod_blocked: false }) };
  }
};
