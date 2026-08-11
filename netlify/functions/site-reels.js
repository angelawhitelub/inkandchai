const { readSiteReels } = require('./utils/site-reels-store');

// public/js/reels.js calls this on EVERY page view, and reels.js is on four
// page templates — so `no-store` meant one uncacheable function invocation per
// visitor per page, for a list that changes when an admin uploads a reel.
//
// The CDN now absorbs that. s-maxage=300 keeps an admin upload visible within
// five minutes, and stale-while-revalidate serves the cached copy instantly for
// a day afterwards while one background request refreshes it — so a burst of
// traffic costs one invocation, not one per visitor. The browser cache is kept
// short so a reader who reloads still sees near-current content.
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=60',
  'Netlify-CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=86400',
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
    // NEVER cache this one: a momentary storage blip would otherwise be pinned
    // at the edge for five minutes, hiding every admin reel from every visitor.
    return {
      statusCode: 200,
      headers: { ...headers, 'Cache-Control': 'no-store, max-age=0', 'Netlify-CDN-Cache-Control': 'no-store' },
      body: JSON.stringify({ items: [], warning: error.message }),
    };
  }
};
