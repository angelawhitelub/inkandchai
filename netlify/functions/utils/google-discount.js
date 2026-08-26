'use strict';

/**
 * Google Merchant "automated discounts" — honouring the discounted price.
 *
 * Google runs its own pricing experiments on our Shopping listings. When it
 * decides to discount an item, the ad's landing URL carries a `pv2` query
 * parameter holding a JWT that Google signed:
 *
 *   /product/<slug>/?pv2=<header>.<payload>.<signature>
 *
 *   header  { alg: 'ES256', typ: 'JWT' }
 *   payload { exp, m: merchantId, o: offerId, c: 'INR', p: discountedPrice }
 *
 * Google's rules: the discounted price must hold on the product page for at
 * least 30 minutes (even after the customer navigates away and comes back
 * without the token) and through checkout for at least 48 hours.
 *
 * WHY THE TWO-TOKEN DANCE
 * -----------------------
 * Google's own token expires after 60 minutes, so it cannot carry a discount
 * across the 48-hour checkout window — and the browser obviously cannot be
 * trusted to name its own price. So the moment we verify Google's token we mint
 * our OWN grant: slug + price + expiry, HMAC-signed with a server-side secret.
 * The browser stores that opaque string and hands it back at checkout, where it
 * is verified again server-side before it can move a single rupee. A grant is
 * unforgeable without the secret, is bound to one slug, and dies on its own.
 *
 * Nothing here ever RAISES a price: a grant is only applied when it undercuts
 * the catalogue price. The worst a stolen or replayed grant can do is give its
 * own slug the discount Google had already decided to give it.
 */

const crypto = require('crypto');

// Published by Google and documented as non-expiring. Overridable so the tests
// can drive the identical code path with a throwaway key pair.
const GOOGLE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAERUlUpxshr67EO66ZTX0Fpog0LEHc
nUnlSsIrOfroxTLu2XnigBK/lfYRxzQWq9K6nqsSjjYeea0T12r+y3nvqg==
-----END PUBLIC KEY-----`;

const MERCHANT_ID = () => String(process.env.GOOGLE_MERCHANT_ID || '5782474419');
const CURRENCY = 'INR';
const GRANT_TTL_MS = 48 * 60 * 60 * 1000;   // Google's checkout requirement

function grantSecret() {
  // A dedicated secret if one is configured; otherwise the admin secret, which
  // already exists in the environment. HMAC never reveals its key.
  return process.env.DISCOUNT_GRANT_SECRET || process.env.ADMIN_SECRET || '';
}

const b64urlDecode = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64urlEncode = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Every id under which this slug could legitimately appear in one of our feeds.
 * The main feed uses the bare slug; the custom feeds prefix `cp-` and fall back
 * to `cp-<sha1(slug)[0:20]>` when that would exceed Google's 50-char id cap
 * (see custom-products-feed.js). The hash is one-way, so we compare forwards
 * from the slug we are pricing rather than trying to reverse the offer id.
 */
function offerIdsForSlug(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return [];
  const hashed = 'cp-' + crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);
  return [s, `cp-${s}`, hashed];
}

function offerMatchesSlug(offerId, slug) {
  const o = String(offerId || '').trim().toLowerCase();
  return !!o && offerIdsForSlug(slug).includes(o);
}

/**
 * Verify Google's pv2 token.
 * @returns {{ok: true, offerId: string, price: number, exp: number}
 *          |{ok: false, reason: string}}
 */
function verifyGoogleToken(token, { publicKeyPem, now = Date.now(), merchantId } = {}) {
  const raw = String(token || '').trim();
  if (!raw) return { ok: false, reason: 'no token' };
  const parts = raw.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };

  let header, payload;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
    payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch { return { ok: false, reason: 'undecodable token' }; }

  // Google pins both header fields. Accepting anything else would let a caller
  // pick a weaker algorithm — the classic JWT downgrade.
  if (header.alg !== 'ES256') return { ok: false, reason: 'unexpected alg' };
  if (header.typ !== 'JWT') return { ok: false, reason: 'unexpected typ' };

  const signature = b64urlDecode(parts[2]);
  // A JWT carries the ECDSA signature as raw r||s, not DER — Node needs telling.
  let signatureOk = false;
  try {
    signatureOk = crypto.verify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      { key: publicKeyPem || GOOGLE_PUBLIC_KEY_PEM, dsaEncoding: 'ieee-p1363' },
      signature,
    );
  } catch { return { ok: false, reason: 'bad signature' }; }
  if (!signatureOk) return { ok: false, reason: 'bad signature' };

  if (!Number.isFinite(Number(payload.exp))) return { ok: false, reason: 'no expiry' };
  if (Number(payload.exp) * 1000 <= now) return { ok: false, reason: 'token expired' };
  if (String(payload.m || '') !== String(merchantId || MERCHANT_ID())) {
    return { ok: false, reason: 'wrong merchant' };
  }
  if (String(payload.c || '').toUpperCase() !== CURRENCY) return { ok: false, reason: 'wrong currency' };

  const price = Number(payload.p);
  if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: 'bad price' };
  if (!payload.o) return { ok: false, reason: 'no offer id' };

  return { ok: true, offerId: String(payload.o), price, exp: Number(payload.exp) };
}

/** Mint our own 48-hour grant for one slug. Opaque to the browser. */
function mintGrant(slug, priceRs, { now = Date.now(), ttlMs = GRANT_TTL_MS } = {}) {
  const secret = grantSecret();
  if (!secret) throw new Error('DISCOUNT_GRANT_SECRET (or ADMIN_SECRET) is not configured');
  const body = { s: String(slug).toLowerCase(), p: Number(priceRs), e: now + ttlMs };
  const payload = b64urlEncode(JSON.stringify(body));
  const sig = b64urlEncode(crypto.createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}

/**
 * @returns {{ok: true, slug: string, price: number, exp: number}
 *          |{ok: false, reason: string}}
 */
function verifyGrant(grant, { now = Date.now() } = {}) {
  const secret = grantSecret();
  if (!secret) return { ok: false, reason: 'grant secret not configured' };
  const parts = String(grant || '').split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed grant' };

  const expected = b64urlEncode(crypto.createHmac('sha256', secret).update(parts[0]).digest());
  const given = Buffer.from(parts[1]);
  const want = Buffer.from(expected);
  // Constant-time, and length-checked first because timingSafeEqual throws on a
  // length mismatch.
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return { ok: false, reason: 'bad grant signature' };
  }

  let body;
  try { body = JSON.parse(b64urlDecode(parts[0]).toString('utf8')); }
  catch { return { ok: false, reason: 'undecodable grant' }; }

  if (!body.s) return { ok: false, reason: 'grant has no slug' };
  if (!Number.isFinite(Number(body.e)) || Number(body.e) <= now) return { ok: false, reason: 'grant expired' };
  const price = Number(body.p);
  if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: 'bad grant price' };

  return { ok: true, slug: String(body.s).toLowerCase(), price, exp: Number(body.e) };
}

/**
 * Turn whatever the browser sent into a slug → price map that pricing.js can
 * trust. Anything that fails verification is silently ignored: a customer with
 * a stale grant pays the ordinary price, which is the safe direction to fail.
 */
function grantMap(grants, { now = Date.now() } = {}) {
  const out = {};
  const list = Array.isArray(grants) ? grants : (grants ? [grants] : []);
  for (const g of list.slice(0, 50)) {
    const v = verifyGrant(g, { now });
    if (!v.ok) continue;
    // Keep the cheapest verified grant per slug.
    if (out[v.slug] === undefined || v.price < out[v.slug]) out[v.slug] = v.price;
  }
  return out;
}

module.exports = {
  verifyGoogleToken, mintGrant, verifyGrant, grantMap,
  offerIdsForSlug, offerMatchesSlug,
  GOOGLE_PUBLIC_KEY_PEM, GRANT_TTL_MS,
};
