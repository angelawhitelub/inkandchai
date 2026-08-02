#!/usr/bin/env node
/**
 * upload-product-video-r2.mjs — put a "book quality proof" video on Cloudflare R2
 * and print the URL to paste into a product's gallery.
 *
 * WHY R2 AND NOT ANYWHERE ELSE
 *   A 13-second clip is ~8 MB — a hundred views is 800 MB. On Netlify that is
 *   billed bandwidth (we are already fighting a 2.8 GB/day bill); on Supabase
 *   Storage it eats the 5 GB/month Cached Egress cap in days. Cloudflare R2
 *   charges ZERO egress, so the same clip costs nothing no matter how often it
 *   plays. Covers already live there (scripts/upload-images-r2.mjs) — same
 *   bucket, same public r2.dev origin.
 *
 * WHAT IT UPLOADS
 *   <slug>-video-N.mp4          the clip itself
 *   <slug>-video-N-poster.webp  the still shown before playback
 *   The "-poster.webp" name is not decoration: product-page.js and
 *   product-gallery-overrides.js derive the poster URL from the video URL by
 *   swapping the extension, so the poster MUST be uploaded under that exact key.
 *
 * PREPARING THE FILE (macOS, no ffmpeg needed)
 *   iPhone .MOV is HEVC, which Chrome and Firefox cannot play. Transcode to
 *   H.264 first, then grab the poster frame:
 *     avconvert -s IMG_1234.MOV -p Preset960x540 -o clip.mp4 --replace
 *     qlmanage -t -s 1080 -o . clip.mp4
 *     cwebp -q 72 clip.mp4.png -o poster.webp
 *   Preset960x540 keeps a portrait clip at 540x960 — enough to read print on a
 *   page, small enough to start fast.
 *
 * RUN (from the repo root)
 *   R2_ACCOUNT_ID=xxxx \
 *   R2_ACCESS_KEY_ID=xxxx \
 *   R2_SECRET_ACCESS_KEY=xxxx \
 *   node scripts/upload-product-video-r2.mjs clip.mp4 <product-slug> [--poster poster.webp] [--n 1]
 *
 * Then paste the printed .mp4 URL into the product's "Gallery image / video
 * URLs" box in the admin panel and save. Nothing else to configure.
 *
 * Your keys are read from the environment, never written to disk or committed.
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';

const BUCKET = process.env.R2_BUCKET || 'inkandchai-images';
// The bucket's public r2.dev origin — the same one IMAGE_CDN_BASE points at.
const PUBLIC_BASE = (process.env.IMAGE_CDN_BASE || 'https://pub-e82e9bd0c7bd4d1eb2de92eb40d0dc33.r2.dev').replace(/\/$/, '');

// Single left-to-right pass so flags may appear anywhere among the positionals.
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
// Bare switches are listed explicitly, otherwise "--attach clip.mp4" would
// swallow the filename as --attach's value and lose a positional argument.
const SWITCHES = new Set(['attach']);
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) { positional.push(argv[i]); continue; }
  const name = argv[i].slice(2);
  if (SWITCHES.has(name)) { flags[name] = true; continue; }
  flags[name] = argv[++i];
}

const videoPath = positional[0];
const slug = String(positional[1] || '').trim().toLowerCase();
const posterPath = typeof flags.poster === 'string' ? flags.poster : '';
const index = Number(flags.n) || 1;
const attach = flags.attach === true;

if (!videoPath || !slug) {
  console.error('usage: node scripts/upload-product-video-r2.mjs <video.mp4> <product-slug> [--poster poster.webp] [--n 1]');
  process.exit(1);
}
if (!existsSync(videoPath)) { console.error(`✗ No such video: ${resolve(videoPath)}`); process.exit(1); }
if (posterPath && !existsSync(posterPath)) { console.error(`✗ No such poster: ${resolve(posterPath)}`); process.exit(1); }

// Browsers refuse to play HEVC-in-MP4 outside Safari, and an iPhone .MOV is
// HEVC. Catch it here rather than after the customer taps play on a black box.
if (/\.mov$/i.test(videoPath)) {
  console.error('✗ Refusing to upload a .MOV — iPhone .MOV is HEVC, which Chrome and Firefox cannot play.');
  console.error('  Transcode first:  avconvert -s "' + videoPath + '" -p Preset960x540 -o clip.mp4 --replace');
  process.exit(1);
}

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
if (!accountId || !accessKeyId || !secretAccessKey) {
  console.error('✗ Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY. See the header of this file.');
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

const TYPES = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.m4v': 'video/x-m4v', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

async function put(key, path) {
  const body = await readFile(path);
  const type = TYPES[extname(path).toLowerCase()];
  if (!type) throw new Error(`unsupported file type: ${basename(path)}`);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: type,
    // Keys are unique per product+index, so a stored object is never re-cut.
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  console.log(`  ✓ ${key}  (${(body.length / 1e6).toFixed(1)} MB)`);
  return `${PUBLIC_BASE}/${key}`;
}

async function main() {
  const videoKey = `${slug}-video-${index}${extname(videoPath).toLowerCase()}`;
  // The renderers build the poster URL by swapping the video's extension, so
  // this key is fixed by that convention — do not rename it.
  const posterKey = `${slug}-video-${index}-poster.webp`;

  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: videoKey }));
    console.warn(`! ${videoKey} already exists — overwriting it (pass --n 2 to add a second clip instead).`);
  } catch { /* not there yet, which is the normal case */ }

  console.log(`• bucket : ${BUCKET}`);
  console.log(`• public : ${PUBLIC_BASE}\n`);

  const videoUrl = await put(videoKey, videoPath);
  let posterUrl = null;
  if (posterPath) posterUrl = await put(posterKey, posterPath);
  else console.warn(`  ! No --poster given. The slide will fall back to the first frame; upload one as ${posterKey} for a clean still.`);

  if (attach) {
    await attachToProduct(videoUrl);
    if (posterUrl) console.log(`(poster served automatically from ${posterUrl})`);
    return;
  }

  console.log('\nPaste this into the product\'s "Gallery image / video URLs" box in the admin panel:\n');
  console.log(`  ${videoUrl}\n`);
  if (posterUrl) console.log(`(poster served automatically from ${posterUrl})\n`);
  console.log('Then Save. The product page renders it as a playable "Real book · video" slide.');
  console.log('Or re-run with --attach to append it to the gallery automatically.');
}

/**
 * Append the video to the product's gallery so the slide goes live without a
 * trip through the admin panel.
 *
 * Deliberately a targeted UPDATE of gallery_images only — never an upsert of a
 * whole row. create-product-listing rebuilds the entire record from its request
 * body, so driving this through that endpoint would blank any field not resent
 * (description, SEO, publisher…). Appending in place cannot lose data.
 *
 * The gallery lives on custom_products; product_overrides only carries the
 * fields it means to override, and its gallery is usually empty.
 */
async function attachToProduct(videoUrl) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('\n✗ --attach needs SUPABASE_URL and SUPABASE_SERVICE_KEY.');
    console.error('  Easiest:  netlify dev:exec -- node scripts/upload-product-video-r2.mjs …  (injects them for you)');
    process.exit(1);
  }
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  for (const table of ['custom_products', 'product_overrides']) {
    const { data, error } = await supabase.from(table).select('slug,gallery_images').eq('slug', slug).maybeSingle();
    if (error) throw error;
    if (!data) continue;

    const existing = Array.isArray(data.gallery_images) ? data.gallery_images : [];
    if (existing.includes(videoUrl)) {
      console.log(`\n• ${table}: video already in the gallery — nothing to change.`);
      return;
    }
    const next = [...existing, videoUrl];   // appended last, after the still images
    const { error: updErr } = await supabase.from(table).update({ gallery_images: next }).eq('slug', slug);
    if (updErr) throw updErr;

    console.log(`\n✓ Added to ${table}.${slug} — gallery is now ${next.length + 1} slides (cover + ${next.length}).`);
    console.log(`  ${videoUrl}`);
    console.log(`\nLive at https://inkandchai.in/product/${slug}/ within ~5 minutes (the product feed is edge-cached).`);
    return;
  }
  console.error(`\n✗ No product found with slug "${slug}" in custom_products or product_overrides.`);
  console.error('  The upload succeeded — check the slug and re-run with --attach.');
  process.exit(1);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
