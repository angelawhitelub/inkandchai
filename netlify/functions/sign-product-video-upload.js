/**
 * Netlify Function: sign-product-video-upload
 * POST /.netlify/functions/sign-product-video-upload
 *
 * Hands the admin panel two short-lived presigned PUT URLs — one for the clip,
 * one for its poster frame — so the browser uploads STRAIGHT to R2.
 *
 * Why not keep using upload-product-video.js: that route carries the clip as
 * base64 inside the request body, which inflates it by a third against a 6 MB
 * serverless limit. That capped a 20 s clip at roughly 1.3 Mbps — far too little
 * for printed text, so book videos stayed blurry no matter how the encoder was
 * tuned. Going direct removes the ceiling, which lets the ORIGINAL phone file be
 * stored with no re-encode at all.
 *
 * upload-product-video.js is deliberately left in place: it still handles the
 * transcode path for clips that are too long, too large, or in a codec the web
 * cannot play.
 *
 * Credentials never reach the browser. Each URL is valid for one key, one
 * method, and ten minutes.
 *
 * Body:
 *   slug          product slug, for a readable object key      REQUIRED
 *   content_type  "video/mp4" or "video/webm"                  REQUIRED
 */

const { requireAdmin } = require('./utils/admin-auth');
const { r2PresignPut, r2Config, r2Configured } = require('./utils/r2-put');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// Same two the transcoder can produce, and the only two the storefront's video
// slide is guaranteed to play.
const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm' };

function safeSlug(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const block = requireAdmin(event, CORS);
  if (block) return block;

  if (!r2Configured()) return json(503, { error: 'R2 is not configured on this deploy.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const slug = safeSlug(body.slug);
  if (!slug) return json(400, { error: 'Missing product slug' });

  const contentType = String(body.content_type || '').toLowerCase().split(';')[0].trim();
  const ext = VIDEO_TYPES[contentType];
  if (!ext) {
    return json(400, { error: `Unsupported video type "${contentType}". Expected video/mp4 or video/webm.` });
  }

  // Same key shape the base64 route writes, so both paths are indistinguishable
  // downstream — and the poster is the video URL with the extension swapped,
  // which is the convention product-page.js and the runtime gallery both assume.
  const stem = `videos/${slug}-video-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const config = r2Config();
    const video = r2PresignPut(config, { key: `${stem}.${ext}`, contentType, expiresIn: 600 });
    const poster = r2PresignPut(config, { key: `${stem}-poster.webp`, contentType: 'image/webp', expiresIn: 600 });
    return json(200, {
      video_upload_url: video.uploadUrl,
      video_url: video.publicUrl,
      poster_upload_url: poster.uploadUrl,
      poster_url: poster.publicUrl,
      content_type: contentType,
    });
  } catch (err) {
    console.error('[sign-product-video-upload]', err.message);
    return json(500, { error: err.message });
  }
};
