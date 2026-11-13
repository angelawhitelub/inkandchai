'use strict';

/**
 * Photos on product reviews.
 *
 * The admin "Add a Review" form sends up to MAX_PHOTOS images as data URLs
 * (already shrunk to WebP in the browser). Each is checked here, stored in the
 * public R2 image bucket (the same one covers live in, zero egress) under
 * reviews/<slug>/, and the public URLs are saved on the review row in
 * product_reviews.photos (jsonb array of strings, sql/product_reviews_photos.sql).
 *
 * One video per review: the browser uploads it straight to R2 through
 * sign-product-video-upload (too big for a request body), then sends only its
 * URL and poster URL here. They are accepted only when they point into our own
 * bucket's videos/ folder, and saved on video_url / video_poster.
 */

const MAX_PHOTOS = 4;
const MAX_BYTES = 3 * 1024 * 1024;
const TYPES = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

/**
 * Parse the request's photos. Throws a customer-readable Error on anything
 * that is not a small JPG/PNG/WebP, so nothing half-uploads.
 * @returns {{buf: Buffer, type: string, ext: string}[]}
 */
function parsePhotos(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error('photos must be a list');
  if (list.length > MAX_PHOTOS) throw new Error(`At most ${MAX_PHOTOS} photos per review`);
  return list.map((raw, i) => {
    const m = String(raw || '').match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!m) throw new Error(`Photo ${i + 1} is not an image`);
    const type = m[1].toLowerCase();
    if (!TYPES[type]) throw new Error(`Photo ${i + 1}: use JPG, PNG or WebP`);
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) throw new Error(`Photo ${i + 1} is empty`);
    if (buf.length > MAX_BYTES) throw new Error(`Photo ${i + 1} is over 3 MB`);
    return { buf, type, ext: TYPES[type] };
  });
}

/** Object key for one photo; slug is reduced to URL-safe characters. */
function photoKey(slug, stamp, i, ext) {
  const s = String(slug || 'book').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'book';
  return `reviews/${s}/${stamp}-${i + 1}.${ext}`;
}

/**
 * Upload parsed photos; returns their public URLs in order.
 * deps.put(key, buf, type) → url (r2PutObject in production).
 */
async function uploadPhotos(slug, photos, deps) {
  const stamp = (deps.now ? deps.now() : Date.now()).toString(36) + Math.random().toString(36).slice(2, 6);
  const urls = [];
  for (const [i, p] of photos.entries()) {
    urls.push(await deps.put(photoKey(slug, stamp, i, p.ext), p.buf, p.type));
  }
  return urls;
}

/** Keep only https URLs from a stored photos value (public pages render these). */
function cleanPhotoUrls(v) {
  return (Array.isArray(v) ? v : [])
    .map(String)
    .filter((u) => /^https:\/\/[^\s"'<>]+$/i.test(u))
    .slice(0, MAX_PHOTOS);
}

/**
 * Check a review video sent by the admin form: {url, poster?}. Both must be in
 * our own bucket (publicBase/videos/…). Returns null for none; throws on junk.
 */
function parseVideo(v, publicBase) {
  if (v == null || v === '') return null;
  const base = String(publicBase || '').replace(/\/+$/, '');
  if (!base) throw new Error('Video storage is not configured');
  const url = String((v && v.url) || '');
  const poster = String((v && v.poster) || '');
  const ours = (u, ext) => u.startsWith(base + '/videos/') && ext.test(u) && /^https:\/\/[^\s"'<>]+$/i.test(u);
  if (!ours(url, /\.(mp4|webm)$/i)) throw new Error('Video upload was not recognised — add it again');
  if (poster && !ours(poster, /\.webp$/i)) throw new Error('Video poster was not recognised — add the video again');
  return { url, poster };
}

/** A missing photos/video column (SQL not run yet) shows up as this kind of error. */
function isMissingPhotosColumn(err) {
  const m = String((err && (err.message || err.details || err.hint)) || '');
  return /(photos|video_url|video_poster)/i.test(m) && /(column|schema cache|does not exist)/i.test(m);
}

module.exports = { MAX_PHOTOS, parsePhotos, photoKey, uploadPhotos, cleanPhotoUrls, parseVideo, isMissingPhotosColumn };
