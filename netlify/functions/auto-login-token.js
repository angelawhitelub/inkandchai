/**
 * Netlify Function: auto-login-token
 * POST /.netlify/functions/auto-login-token
 *
 * Deprecated: this endpoint used to return a server-generated Supabase magic
 * link token to the browser. That allowed instant email-only login, so it now
 * refuses all requests. Use Supabase signInWithOtp from the browser instead;
 * the customer must click the email link before a session is created.
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  return {
    statusCode: 410,
    headers: CORS,
    body: JSON.stringify({ error: 'Instant email login is disabled. Use email OTP/magic-link verification.' }),
  };
};
