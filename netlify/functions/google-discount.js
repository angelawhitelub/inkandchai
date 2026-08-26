/**
 * POST /.netlify/functions/google-discount
 *
 * PUBLIC. The storefront calls this when a visitor arrives from a Shopping ad
 * carrying Google's `pv2` token. We verify Google's signature server-side and,
 * if it is genuine and really is for this product, hand back the discounted
 * price plus an opaque 48-hour grant the browser replays at checkout.
 *
 * Body: { pv2: "<jwt>", slug: "<product-slug>" }
 * 200:  { ok: true, price, grant, expires_at }
 * 200:  { ok: false, reason }   ← a bad token is not a server error; the page
 *                                 simply shows the ordinary price.
 */

const {
  verifyGoogleToken, mintGrant, offerMatchesSlug, GRANT_TTL_MS,
} = require('./utils/google-discount');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { ok: false, reason: 'Method Not Allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, reason: 'Invalid JSON' }); }

  const slug = String(body.slug || '').trim().toLowerCase();
  if (!slug) return json(400, { ok: false, reason: 'slug required' });

  const verified = verifyGoogleToken(body.pv2);
  if (!verified.ok) {
    console.log(`[google-discount] rejected token for ${slug}: ${verified.reason}`);
    return json(200, { ok: false, reason: verified.reason });
  }

  // The token names the offer it discounts. Without this check a token for a
  // ₹99 book would discount a ₹2,000 one.
  if (!offerMatchesSlug(verified.offerId, slug)) {
    console.log(`[google-discount] offer ${verified.offerId} is not ${slug}`);
    return json(200, { ok: false, reason: 'token is for a different product' });
  }

  let grant;
  try { grant = mintGrant(slug, verified.price); }
  catch (err) {
    // Misconfiguration, not a customer problem — say so loudly in the logs and
    // let the page fall back to the ordinary price.
    console.error('[google-discount] cannot mint grant:', err.message);
    return json(200, { ok: false, reason: 'discounts unavailable' });
  }

  console.log(`[google-discount] honouring Rs ${verified.price} on ${slug}`);
  return json(200, {
    ok: true,
    slug,
    price: verified.price,
    grant,
    expires_at: new Date(Date.now() + GRANT_TTL_MS).toISOString(),
  });
};
