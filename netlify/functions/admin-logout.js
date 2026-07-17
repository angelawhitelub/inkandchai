const { ADMIN_COOKIE_NAME } = require('./utils/admin-auth');

const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  return {
    statusCode: 200,
    headers: {
      ...HEADERS,
      'Set-Cookie': `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    },
    body: JSON.stringify({ ok: true }),
  };
};
