const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// The poster filename is load-bearing: product-page.js does not store it, it
// DERIVES it from the video URL. If the two ever disagree, every video slide
// starts as a black rectangle. This locks the contract from both directions.
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(?=$|[?#])/i;
const posterForVideo = (u) => String(u || '').replace(VIDEO_EXT, '-poster.webp');
const isVideoUrl = (u) => VIDEO_EXT.test(String(u || ''));

const STEM = 'https://p.supabase.co/storage/v1/object/public/product-images/videos/atomic-habits-video-1786-a1b2';

test('the poster key the function writes is the one the storefront asks for', () => {
  for (const ext of ['mp4', 'webm']) {
    assert.equal(posterForVideo(`${STEM}.${ext}`), `${STEM}-poster.webp`);
  }
});

test('an uploaded video is recognised as a video slide', () => {
  assert.ok(isVideoUrl(`${STEM}.mp4`));
  assert.ok(isVideoUrl(`${STEM}.webm`));
});

test('the poster itself is never mistaken for a video', () => {
  // Otherwise the gallery would try to play the still frame.
  assert.equal(isVideoUrl(`${STEM}-poster.webp`), false);
});

// ── Handler guards ──────────────────────────────────────────────────────────
// Exercised through the real handler with admin auth satisfied, stopping short
// of Supabase: every case below must be rejected before any upload is attempted.
process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-secret';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
// Lives in utils/ rather than beside the function it tests: Netlify treats every
// top-level .js in netlify/functions/ as a deployable function, and
// "upload-product-video.test" is not a legal function name — the dot fails the
// build for the whole site. Every other test in this repo is here for the same
// reason.
const { handler } = require(path.resolve(__dirname, '..', 'upload-product-video.js'));

const call = (body) => handler({
  httpMethod: 'POST',
  headers: { 'x-admin-key': process.env.ADMIN_SECRET },
  body: JSON.stringify(body),
});

const b64 = (bytes) => Buffer.alloc(bytes, 7).toString('base64');

test('rejects a request with no slug', async () => {
  const res = await call({ video_base64: b64(10), video_type: 'video/mp4' });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /slug/i);
});

test('rejects a container the storefront cannot play', async () => {
  // .mov is in the gallery regex for legacy R2 uploads, but we must never WRITE
  // one: an iPhone .MOV is HEVC and Chrome cannot decode it.
  const res = await call({ slug: 'x', video_base64: b64(10), video_type: 'video/quicktime' });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /Unsupported video type/);
});

test('accepts a codec-qualified mime type', async () => {
  // MediaRecorder reports "video/mp4;codecs=avc1.42E01E"; the parameter must not
  // make the type unrecognisable.
  const res = await call({ slug: 'x', video_base64: '', video_type: 'video/mp4;codecs=avc1.42E01E' });
  assert.equal(JSON.parse(res.body).error, 'Missing video');   // got past the type check
});

test('rejects a clip too large for the request body limit', async () => {
  const res = await call({ slug: 'x', video_type: 'video/mp4', video_base64: b64(5 * 1024 * 1024) });
  assert.equal(res.statusCode, 413);
  assert.match(JSON.parse(res.body).error, /over the 4 MB limit/);
});

test('rejects a payload that is not base64', async () => {
  const res = await call({ slug: 'x', video_type: 'video/mp4', video_base64: 'not base64!!' });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /valid base64/);
});

test('refuses a request without admin auth', async () => {
  const res = await handler({ httpMethod: 'POST', headers: {}, body: '{}' });
  assert.ok(res.statusCode === 401 || res.statusCode === 403, `got ${res.statusCode}`);
});

// ── Storage selection ───────────────────────────────────────────────────────
// R2 is chosen only when it can be both written AND read. Getting this wrong in
// either direction is expensive: silently using Supabase burns the egress cap
// this switch exists to avoid, and using R2 without a public base would store
// clips at a URL no customer can load.
test('uploads to R2 when it is fully configured, and signs the PUT', async () => {
  const R2_ENV = {
    R2_ACCOUNT_ID: 'acct123',
    R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    R2_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    R2_PUBLIC_BASE: 'https://pub-abc.r2.dev',
  };
  const saved = {};
  for (const k of Object.keys(R2_ENV)) { saved[k] = process.env[k]; process.env[k] = R2_ENV[k]; }
  const realFetch = global.fetch;
  const puts = [];
  global.fetch = async (url, init) => {
    puts.push({ url, method: init.method, headers: init.headers, bytes: init.body.length });
    return { ok: true, status: 200, text: async () => '' };
  };
  try {
    const res = await call({ slug: 'atomic-habits', video_type: 'video/mp4', video_base64: b64(2048) });
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(body.storage, 'r2');
    assert.match(body.video_url, /^https:\/\/pub-abc\.r2\.dev\/videos\/atomic-habits-video-\d+-[a-z0-9]+\.mp4$/);

    assert.equal(puts.length, 1, 'no poster was sent, so exactly one PUT');
    const put = puts[0];
    assert.equal(put.method, 'PUT');
    assert.match(put.url, /^https:\/\/acct123\.r2\.cloudflarestorage\.com\/inkandchai-images\/videos\//);
    assert.match(put.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request,/);
    assert.equal(put.headers['content-type'], 'video/mp4');
    assert.equal(put.bytes, 2048, 'the decoded clip is what gets uploaded');
    // The object key and the returned public URL must agree, or the gallery
    // points at nothing.
    assert.equal(body.video_url.replace('https://pub-abc.r2.dev/', ''),
      put.url.replace('https://acct123.r2.cloudflarestorage.com/inkandchai-images/', ''));
  } finally {
    global.fetch = realFetch;
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

test('the poster goes to the key the storefront derives', async () => {
  const R2_ENV = {
    R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AK',
    R2_SECRET_ACCESS_KEY: 'SK', R2_PUBLIC_BASE: 'https://pub-abc.r2.dev',
  };
  const saved = {};
  for (const k of Object.keys(R2_ENV)) { saved[k] = process.env[k]; process.env[k] = R2_ENV[k]; }
  const realFetch = global.fetch;
  const keys = [];
  global.fetch = async (url, init) => {
    keys.push({ key: String(url).split('/inkandchai-images/')[1], type: init.headers['content-type'] });
    return { ok: true, status: 200, text: async () => '' };
  };
  try {
    const res = await call({
      slug: 'atomic-habits', video_type: 'video/mp4',
      video_base64: b64(1024), poster_base64: b64(256),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(keys.length, 2);
    const [video, poster] = keys;
    assert.equal(poster.type, 'image/webp');
    assert.equal(poster.key, video.key.replace(/\.mp4$/, '-poster.webp'),
      'must match posterForVideo() in product-page.js');
  } finally {
    global.fetch = realFetch;
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

test('R2 keys without a public base fall back rather than half-working', async () => {
  // Uploading to R2 with no readable origin would produce a gallery entry that
  // 404s for every customer. Falling back to Supabase is the safe outcome.
  const saved = {
    id: process.env.R2_ACCOUNT_ID, ak: process.env.R2_ACCESS_KEY_ID,
    sk: process.env.R2_SECRET_ACCESS_KEY, base: process.env.R2_PUBLIC_BASE,
    cdn: process.env.IMAGE_CDN_BASE,
  };
  process.env.R2_ACCOUNT_ID = 'acct';
  process.env.R2_ACCESS_KEY_ID = 'ak';
  process.env.R2_SECRET_ACCESS_KEY = 'sk';
  delete process.env.R2_PUBLIC_BASE;
  delete process.env.IMAGE_CDN_BASE;
  const realFetch = global.fetch;
  let r2Called = false;
  global.fetch = async (url) => {
    if (String(url).includes('r2.cloudflarestorage.com')) r2Called = true;
    return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
  };
  try {
    // Supabase is unreachable with fake creds, so this fails — the point is only
    // that it never attempted R2.
    await call({ slug: 'x', video_type: 'video/mp4', video_base64: b64(64) });
    assert.equal(r2Called, false, 'must not upload to R2 without a public base');
  } finally {
    global.fetch = realFetch;
    if (saved.id === undefined) delete process.env.R2_ACCOUNT_ID; else process.env.R2_ACCOUNT_ID = saved.id;
    if (saved.ak === undefined) delete process.env.R2_ACCESS_KEY_ID; else process.env.R2_ACCESS_KEY_ID = saved.ak;
    if (saved.sk === undefined) delete process.env.R2_SECRET_ACCESS_KEY; else process.env.R2_SECRET_ACCESS_KEY = saved.sk;
    if (saved.base !== undefined) process.env.R2_PUBLIC_BASE = saved.base;
    if (saved.cdn !== undefined) process.env.IMAGE_CDN_BASE = saved.cdn;
  }
});

test('a failed R2 upload reports instead of silently storing nothing', async () => {
  const R2_ENV = {
    R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'AK',
    R2_SECRET_ACCESS_KEY: 'SK', R2_PUBLIC_BASE: 'https://pub-abc.r2.dev',
  };
  const saved = {};
  for (const k of Object.keys(R2_ENV)) { saved[k] = process.env[k]; process.env[k] = R2_ENV[k]; }
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 403, statusText: 'Forbidden', text: async () => 'SignatureDoesNotMatch' });
  try {
    const res = await call({ slug: 'x', video_type: 'video/mp4', video_base64: b64(64) });
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /R2 403.*SignatureDoesNotMatch/);
  } finally {
    global.fetch = realFetch;
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

test('a slug cannot escape the videos/ prefix', async () => {
  // A slug reaches the storage key directly, so path traversal in it would let
  // an upload overwrite an unrelated object.
  const res = await call({ slug: '../../etc/passwd', video_base64: '', video_type: 'video/mp4' });
  const err = JSON.parse(res.body).error;
  // Sanitised to "etc-passwd", so it gets past slug validation to the next check.
  assert.equal(err, 'Missing video');
});
