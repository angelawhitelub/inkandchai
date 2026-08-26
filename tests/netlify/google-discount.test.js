'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const {
  verifyGoogleToken, mintGrant, verifyGrant, grantMap,
  offerMatchesSlug, GOOGLE_PUBLIC_KEY_PEM,
} = require('../../netlify/functions/utils/google-discount');

process.env.DISCOUNT_GRANT_SECRET = 'test-grant-secret';

// A throwaway P-256 pair so the tests exercise the real ES256 path.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function sign(payload, { header = { alg: 'ES256', typ: 'JWT' }, key = privateKey } = {}) {
  const p = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign('sha256', Buffer.from(p), { key, dsaEncoding: 'ieee-p1363' });
  return `${p}.${b64url(sig)}`;
}

const future = () => Math.floor(Date.now() / 1000) + 1800;
const claims = (over = {}) => ({ exp: future(), m: '5782474419', o: 'cp-a-book', c: 'INR', p: 367.65, ...over });
const opts = { publicKeyPem: PEM };

test('a properly signed Google token is accepted', () => {
  const r = verifyGoogleToken(sign(claims()), opts);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.price, 367.65);
  assert.strictEqual(r.offerId, 'cp-a-book');
});

test('a token signed by anyone else is rejected', () => {
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const r = verifyGoogleToken(sign(claims(), { key: other }), opts);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /signature/);
});

test('a tampered price does not survive verification', () => {
  const good = sign(claims({ p: 400 }));
  const [h, , s] = good.split('.');
  const forged = `${h}.${b64url(JSON.stringify(claims({ p: 1 })))}.${s}`;
  assert.strictEqual(verifyGoogleToken(forged, opts).ok, false);
});

test('alg:none and other downgrades are refused', () => {
  for (const alg of ['none', 'HS256', 'RS256']) {
    const r = verifyGoogleToken(sign(claims(), { header: { alg, typ: 'JWT' } }), opts);
    assert.strictEqual(r.ok, false, `${alg} should be refused`);
    assert.match(r.reason, /alg/);
  }
});

test('an HS256 token signed with the public key as secret is refused', () => {
  // The classic confusion attack: without the alg pin, this would verify.
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims()));
  const sig = b64url(crypto.createHmac('sha256', PEM).update(`${head}.${body}`).digest());
  assert.strictEqual(verifyGoogleToken(`${head}.${body}.${sig}`, opts).ok, false);
});

test('an expired token is refused', () => {
  const r = verifyGoogleToken(sign(claims({ exp: Math.floor(Date.now() / 1000) - 10 })), opts);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /expired/);
});

test('another merchant cannot discount our catalogue', () => {
  const r = verifyGoogleToken(sign(claims({ m: '999999' })), opts);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /merchant/);
});

test('a non-INR token is refused', () => {
  assert.match(verifyGoogleToken(sign(claims({ c: 'USD' })), opts).reason, /currency/);
});

test('a nonsense price is refused', () => {
  for (const p of [0, -5, 'free', null]) {
    assert.strictEqual(verifyGoogleToken(sign(claims({ p })), opts).ok, false, `price ${p}`);
  }
});

test('junk input never throws', () => {
  for (const t of ['', null, undefined, 'a.b', 'a.b.c', '...', 'x'.repeat(5000)]) {
    const r = verifyGoogleToken(t, opts);
    assert.strictEqual(r.ok, false);
  }
});

test('the real Google key is the default and rejects our test tokens', () => {
  assert.match(GOOGLE_PUBLIC_KEY_PEM, /BEGIN PUBLIC KEY/);
  assert.strictEqual(verifyGoogleToken(sign(claims())).ok, false);
});

// ── offer id ↔ slug ────────────────────────────────────────────────────────
test('an offer id is matched against every feed id form of the slug', () => {
  assert.ok(offerMatchesSlug('a-book-123', 'a-book-123'));          // main feed
  assert.ok(offerMatchesSlug('cp-a-book-123', 'a-book-123'));       // custom feed
  assert.ok(offerMatchesSlug('CP-A-BOOK-123', 'a-book-123'));       // case-insensitive
  const long = 'x'.repeat(60);
  const hashed = 'cp-' + crypto.createHash('sha1').update(long).digest('hex').slice(0, 20);
  assert.ok(offerMatchesSlug(hashed, long), 'hashed id form must match');
});

test('a token for one product cannot discount another', () => {
  assert.strictEqual(offerMatchesSlug('cp-atomic-habits', 'ikigai'), false);
  assert.strictEqual(offerMatchesSlug('', 'ikigai'), false);
});

// ── our own 48-hour grant ──────────────────────────────────────────────────
test('a minted grant verifies and carries the price', () => {
  const g = mintGrant('a-book', 367.65);
  const v = verifyGrant(g);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.price, 367.65);
  assert.strictEqual(v.slug, 'a-book');
});

test('a grant cannot be edited to a cheaper price', () => {
  const g = mintGrant('a-book', 367.65);
  const forged = `${b64url(JSON.stringify({ s: 'a-book', p: 1, e: Date.now() + 1000 }))}.${g.split('.')[1]}`;
  assert.strictEqual(verifyGrant(forged).ok, false);
});

test('a grant forged without the secret is refused', () => {
  const body = b64url(JSON.stringify({ s: 'a-book', p: 1, e: Date.now() + 1000 }));
  const sig = b64url(crypto.createHmac('sha256', 'not-the-secret').update(body).digest());
  assert.strictEqual(verifyGrant(`${body}.${sig}`).ok, false);
});

test('a grant expires, and 48 hours is the window Google requires', () => {
  const now = Date.now();
  const g = mintGrant('a-book', 100, { now });
  assert.strictEqual(verifyGrant(g, { now: now + 47 * 3600 * 1000 }).ok, true);
  assert.strictEqual(verifyGrant(g, { now: now + 49 * 3600 * 1000 }).ok, false);
});

test('grantMap keeps only what verifies, and the cheapest per slug', () => {
  const good = mintGrant('a-book', 300);
  const cheaper = mintGrant('a-book', 250);
  const other = mintGrant('b-book', 99);
  const map = grantMap([good, cheaper, other, 'garbage', '', null]);
  assert.deepStrictEqual(map, { 'a-book': 250, 'b-book': 99 });
});

test('grantMap never throws on hostile input', () => {
  assert.deepStrictEqual(grantMap(null), {});
  assert.deepStrictEqual(grantMap('nonsense'), {});
  assert.deepStrictEqual(grantMap(Array(500).fill('x.y')), {});
});
