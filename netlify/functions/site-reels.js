const { readSiteReels } = require('./utils/site-reels-store');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json; charset=utf-8',
  // Admin uploads should become visible on the next page view, not hours later.
  'Cache-Control': 'no-store, max-age=0',
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  try {
    return { statusCode: 200, headers, body: JSON.stringify({ items: await readSiteReels() }) };
  } catch (error) {
    console.error('[site-reels]', error.message);
    // Existing five reels must remain usable even if dynamic storage is down.
    return { statusCode: 200, headers, body: JSON.stringify({ items: [], warning: error.message }) };
  }
};
