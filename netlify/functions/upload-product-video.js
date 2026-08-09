/**
 * Netlify Function: upload-product-video
 * POST /.netlify/functions/upload-product-video
 *
 * Stores a "quality proof" clip (the real book — paper, print, binding) plus its
 * poster frame on Cloudflare R2, and returns the public URLs.
 *
 * R2 because Cloudflare charges ZERO egress: a clip played thousands of times
 * costs nothing, whereas on Supabase Storage it eats the 5 GB/month cached-egress
 * cap and on Netlify it is billed bandwidth. Covers already live in the same
 * bucket (scripts/upload-images-r2.mjs). Supabase Storage remains the fallback
 * for when R2 is not configured, so a missing env var degrades instead of
 * breaking the feature — check the returned `storage` field to see which ran.
 *
 * It does NOT touch the product row:
 * the admin panel takes the returned video URL and saves it through the existing
 * gallery "append" path, so the clip lands at the END of gallery_images, after
 * every cover image. That is also why nothing here needs a schema change —
 * product-page.js already renders any gallery entry ending in .mp4/.webm as a
 * playable slide.
 *
 * The poster filename is NOT cosmetic. product-page.js derives it from the video
 * URL by swapping the extension for "-poster.webp", so the poster MUST be stored
 * under exactly that key or the slide shows a black rectangle until it plays.
 *
 * Body:
 *   slug           product slug, used only to name the files          REQUIRED
 *   video_base64   bare base64 (no data: prefix) of the clip          REQUIRED
 *   video_type     "video/mp4" or "video/webm"                        REQUIRED
 *   poster_base64  bare base64 of the WebP poster frame               optional
 *
 * Transcoding happens in the browser before the upload — see iacTranscodeVideo
 * in public/admin/index.html. A serverless function cannot do it: there is no
 * ffmpeg in the runtime, and the request body limit is smaller than a raw phone
 * clip, so an untranscoded upload could never even arrive here.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { r2PutObject, r2Configured, r2Config } = require('./utils/r2-put');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const BUCKET = 'product-images';
// Comfortably inside the serverless request-body limit once base64 inflates the
// payload by a third. The browser now derives its bitrate from the clip length to
// land just under ~3.2 MB whatever the duration (see videoBitrateFor in
// public/admin/index.html), so this stays a backstop rather than a routine limit.
const MAX_VIDEO_BYTES = 4 * 1024 * 1024;
const MAX_POSTER_BYTES = 512 * 1024;

const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm' };

function safeSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function decodeBase64(value, label) {
  const raw = String(value || '').trim().replace(/^data:[^,]*,/, '');
  if (!raw) throw new Error(`Missing ${label}`);
  if (!/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(raw)) throw new Error(`${label} is not valid base64`);
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) throw new Error(`${label} decoded to nothing`);
  return buffer;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY are required.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const slug = safeSlug(body.slug);
  if (!slug) return json(400, { error: 'Missing product slug' });

  const videoType = String(body.video_type || '').toLowerCase().split(';')[0].trim();
  const ext = VIDEO_TYPES[videoType];
  if (!ext) {
    return json(400, { error: `Unsupported video type "${videoType}". Expected video/mp4 or video/webm.` });
  }

  let video, poster = null;
  try {
    video = decodeBase64(body.video_base64, 'video');
    if (body.poster_base64) poster = decodeBase64(body.poster_base64, 'poster');
  } catch (err) {
    return json(400, { error: err.message });
  }

  if (video.length > MAX_VIDEO_BYTES) {
    return json(413, {
      error: `The clip is ${(video.length / 1048576).toFixed(1)} MB after compression, over the ${MAX_VIDEO_BYTES / 1048576} MB limit. Trim it shorter and try again.`,
    });
  }
  if (poster && poster.length > MAX_POSTER_BYTES) poster = null;   // nice-to-have, never fatal

  // One stem for both files so posterForVideo() in product-page.js resolves.
  const stem = `videos/${slug}-video-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const videoKey = `${stem}.${ext}`;
  const posterKey = `${stem}-poster.webp`;

  try {
    // R2 when it is fully configured, Supabase Storage otherwise. R2 is strongly
    // preferred: Cloudflare charges zero egress, so a clip played thousands of
    // times costs nothing, while the same file on Supabase eats the 5 GB/month
    // cached-egress cap. Partial R2 config falls back instead of half-working.
    const useR2 = r2Configured();
    let videoUrl = null;
    let posterUrl = null;

    if (useR2) {
      const cfg = r2Config();
      videoUrl = await r2PutObject(cfg, { key: videoKey, body: video, contentType: videoType });
      if (poster) {
        // A missing poster costs a black first frame, not a broken gallery — so a
        // poster failure must not lose the clip that already uploaded.
        try {
          posterUrl = await r2PutObject(cfg, { key: posterKey, body: poster, contentType: 'image/webp' });
        } catch (e) { console.warn('[upload-product-video] R2 poster failed:', e.message); }
      }
    } else {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      await supabase.storage.createBucket(BUCKET, { public: true }).catch(() => {});

      const { error: videoErr } = await supabase.storage
        .from(BUCKET).upload(videoKey, video, { contentType: videoType, upsert: false });
      if (videoErr) throw videoErr;

      if (poster) {
        const { error: posterErr } = await supabase.storage
          .from(BUCKET).upload(posterKey, poster, { contentType: 'image/webp', upsert: false });
        if (posterErr) console.warn('[upload-product-video] poster failed:', posterErr.message);
        else posterUrl = supabase.storage.from(BUCKET).getPublicUrl(posterKey).data?.publicUrl || null;
      }

      videoUrl = supabase.storage.from(BUCKET).getPublicUrl(videoKey).data?.publicUrl || null;
    }

    if (!videoUrl) throw new Error('Could not create a public video URL');

    console.log(`[upload-product-video] ${slug}: ${(video.length / 1024).toFixed(0)} KB ${ext}`
      + `${posterUrl ? ' + poster' : ' (no poster)'} → ${useR2 ? 'R2' : 'Supabase Storage'}`);
    return json(200, {
      success: true,
      video_url: videoUrl,
      poster_url: posterUrl,
      bytes: video.length,
      storage: useR2 ? 'r2' : 'supabase',
    });
  } catch (err) {
    console.error('[upload-product-video]', err.message);
    return json(500, { error: err.message });
  }
};
