const { requireAdmin } = require('./utils/admin-auth');
const { readSiteReels, writeSiteReels } = require('./utils/site-reels-store');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json; charset=utf-8',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;
  try {
    if (event.httpMethod === 'GET') return json(200, { items: await readSiteReels() });
    if (event.httpMethod === 'DELETE') {
      const id = String(event.queryStringParameters?.id || '').trim();
      if (!id) return json(400, { error: 'Missing reel id' });
      const current = await readSiteReels();
      const next = current.filter(item => item.id !== id);
      if (next.length === current.length) return json(404, { error: 'Reel not found' });
      await writeSiteReels(next);
      return json(200, { success: true, items: next });
    }
    return json(405, { error: 'Method Not Allowed' });
  } catch (error) {
    console.error('[admin-site-reels]', error.message);
    return json(500, { error: error.message });
  }
};
