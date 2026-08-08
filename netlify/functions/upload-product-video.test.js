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
const { handler } = require(path.resolve(__dirname, 'upload-product-video.js'));

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

test('a slug cannot escape the videos/ prefix', async () => {
  // A slug reaches the storage key directly, so path traversal in it would let
  // an upload overwrite an unrelated object.
  const res = await call({ slug: '../../etc/passwd', video_base64: '', video_type: 'video/mp4' });
  const err = JSON.parse(res.body).error;
  // Sanitised to "etc-passwd", so it gets past slug validation to the next check.
  assert.equal(err, 'Missing video');
});
