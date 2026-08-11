const { requireAdmin } = require('./utils/admin-auth');
const { r2PutObject, r2Configured, r2Config } = require('./utils/r2-put');
const { BUCKET, client, ensureBucket, readSiteReels, writeSiteReels, MAX_REELS } = require('./utils/site-reels-store');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json; charset=utf-8',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm' };
const MAX_VIDEO_BYTES = 4 * 1024 * 1024;
const MAX_POSTER_BYTES = 512 * 1024;

function decodeBase64(value, label) {
  const raw = String(value || '').trim().replace(/^data:[^,]*,/, '');
  if (!raw) throw new Error(`Missing ${label}`);
  if (!/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(raw)) throw new Error(`${label} is not valid base64`);
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) throw new Error(`${label} decoded to nothing`);
  return buffer;
}

function cleanDirectUrl(value, kind) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw new Error(`Invalid ${kind} URL`); }
  if (url.protocol !== 'https:') throw new Error(`${kind} URL must use HTTPS`);
  const allowedBases = [process.env.R2_PUBLIC_BASE, process.env.IMAGE_CDN_BASE]
    .filter(Boolean).map(base => String(base).replace(/\/+$/, '') + '/');
  if (!allowedBases.some(base => url.href.startsWith(base))) {
    throw new Error(`${kind} URL is not on the configured media storage`);
  }
  return url.href;
}

async function appendReel(current, body, videoUrl, posterUrl, extra = {}) {
  if (current.length >= MAX_REELS) {
    const error = new Error(`The admin reel limit of ${MAX_REELS} has been reached.`);
    error.statusCode = 409;
    throw error;
  }
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const item = {
    id,
    src: videoUrl,
    poster: posterUrl || '',
    caption: String(body.caption || '').trim().slice(0, 180),
    instagram: '',
    type: 'video',
    created_at: new Date().toISOString(),
    position: current.reduce((max, row) => Math.max(max, Number(row.position) || 0), 0) + 1,
  };
  await writeSiteReels([...current, item]);
  return { success: true, item, ...extra };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  // Web-ready MP4s upload straight from the browser to R2 using a short-lived
  // signed PUT. Register that already-stored URL here so original resolution,
  // bitrate and audio are preserved without passing a huge file through Lambda.
  if (body.video_url) {
    try {
      const videoUrl = cleanDirectUrl(body.video_url, 'video');
      if (!/\.(?:mp4|webm)(?:$|[?#])/i.test(videoUrl)) throw new Error('Direct reel URL must be MP4 or WebM');
      const posterUrl = body.poster_url ? cleanDirectUrl(body.poster_url, 'poster') : '';
      const current = await readSiteReels();
      return json(200, await appendReel(current, body, videoUrl, posterUrl, { storage: 'r2-direct' }));
    } catch (error) {
      return json(error.statusCode || 400, { error: error.message });
    }
  }

  const videoType = String(body.video_type || '').toLowerCase().split(';')[0].trim();
  const ext = VIDEO_TYPES[videoType];
  if (!ext) return json(400, { error: 'Use an MP4 or WebM video.' });

  let video;
  let poster = null;
  try {
    video = decodeBase64(body.video_base64, 'video');
    if (body.poster_base64) poster = decodeBase64(body.poster_base64, 'poster');
  } catch (error) { return json(400, { error: error.message }); }
  if (video.length > MAX_VIDEO_BYTES) return json(413, { error: 'Compressed video is over the 4 MB upload limit.' });
  if (poster && poster.length > MAX_POSTER_BYTES) poster = null;

  try {
    const current = await readSiteReels();
    if (current.length >= MAX_REELS) return json(409, { error: `The admin reel limit of ${MAX_REELS} has been reached.` });

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const stem = `reels/admin/${id}`;
    const videoKey = `${stem}.${ext}`;
    const posterKey = `${stem}-poster.webp`;
    let videoUrl = '';
    let posterUrl = '';
    let storage = 'supabase';

    if (r2Configured()) {
      storage = 'r2';
      const cfg = r2Config();
      videoUrl = await r2PutObject(cfg, { key: videoKey, body: video, contentType: videoType });
      if (poster) posterUrl = await r2PutObject(cfg, { key: posterKey, body: poster, contentType: 'image/webp' });
    } else {
      const supabase = client();
      await ensureBucket(supabase);
      const { error: videoError } = await supabase.storage.from(BUCKET).upload(videoKey, video, {
        contentType: videoType, cacheControl: '31536000', upsert: false,
      });
      if (videoError) throw videoError;
      videoUrl = supabase.storage.from(BUCKET).getPublicUrl(videoKey).data?.publicUrl || '';
      if (poster) {
        const { error: posterError } = await supabase.storage.from(BUCKET).upload(posterKey, poster, {
          contentType: 'image/webp', cacheControl: '31536000', upsert: false,
        });
        if (!posterError) posterUrl = supabase.storage.from(BUCKET).getPublicUrl(posterKey).data?.publicUrl || '';
      }
    }
    if (!videoUrl) throw new Error('Could not create a public video URL');

    return json(200, await appendReel(current, body, videoUrl, posterUrl, { storage, bytes: video.length }));
  } catch (error) {
    console.error('[upload-site-reel]', error.message);
    return json(500, { error: error.message });
  }
};
