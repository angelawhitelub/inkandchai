const { getAdminPayload } = require('./utils/admin-auth');

const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  const payload = getAdminPayload(event);
  if (!payload) {
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ ok: false }) };
  }
  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ ok: true, exp: payload.exp, sub: payload.sub }),
  };
};
