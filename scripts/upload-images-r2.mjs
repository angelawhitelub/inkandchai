#!/usr/bin/env node
/**
 * upload-images-r2.mjs — move product cover images off Netlify onto Cloudflare R2.
 *
 * WHY: /.netlify/functions/image-proxy was serving ~889 MB/day (~26 GB/month) of
 * Netlify bandwidth because every cover is streamed through our own domain. R2
 * charges ZERO egress, so once these are served from img.inkandchai.in the
 * Netlify image bandwidth goes to 0 — and because it's our own subdomain, the
 * supplier CDN stays hidden exactly like the proxy did.
 *
 * WHAT IT DOES
 *   Reads netlify/functions/image-map.json (token -> source Shopify URL) and, for
 *   each cover, downloads RESIZED WebP renditions from Shopify at the widths the
 *   pages actually render (400px cards, 800px product hero), uploading each as
 *   "<token>-<width>.webp". Those keys are exactly what public_image_url() emits
 *   when IMAGE_CDN_BASE is set, so switching hosts changes only a base URL.
 *
 * SETUP (one time, in your Cloudflare account)
 *   1. R2 → Create bucket, name it:  inkandchai-images
 *   2. Bucket → Settings → Public access → Connect a custom domain
 *        domain:  img.inkandchai.in
 *      Cloudflare adds the DNS record for you. Wait until it shows "Active".
 *   3. R2 → Manage API tokens → Create token (Object Read & Write for that bucket).
 *      Note the Access Key ID, Secret Access Key, and your Account ID.
 *
 * RUN (from the repo root)
 *   R2_ACCOUNT_ID=xxxx \
 *   R2_ACCESS_KEY_ID=xxxx \
 *   R2_SECRET_ACCESS_KEY=xxxx \
 *   node scripts/upload-images-r2.mjs
 *
 * Flags:
 *   --limit=50     only do the first N (use this for a smoke test first)
 *   --force        re-upload even if the object already exists
 *   --widths=400,800  renditions to build (default 400,800)
 *
 * Safe to re-run: it skips objects that already exist unless --force is passed.
 * Your keys are read from the environment, never written to disk or committed.
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const BUCKET = process.env.R2_BUCKET || 'inkandchai-images';

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};
const LIMIT = Number(argVal('limit', 0)) || 0;
const FORCE = args.includes('--force');
// Two renditions per cover, matching IMG_W_CARD / IMG_W_HERO in generate_site.py.
// Keys are "<token>-<width>.webp", which is exactly what public_image_url()
// emits when IMAGE_CDN_BASE is set.
const WIDTHS = (argVal('widths', '400,800')).split(',').map(Number).filter(n => n >= 200 && n <= 1600);

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

async function exists(key) {
  try { await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); return true; }
  catch { return false; }
}

// Shopify's CDN resizes and format-negotiates for us: ask for width=N and send
// an Accept that prefers WebP. A 1500px JPEG (~129 KB) comes back as a 400px
// WebP (~38 KB) — 70% smaller before it ever touches R2.
async function fetchOptimised(sourceUrl, width) {
  const u = new URL(sourceUrl);
  u.searchParams.set('width', String(width));
  const res = await fetch(u.toString(), {
    headers: {
      'user-agent': 'InkAndChaiImageMigrate/1.0',
      'accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error(`not an image (${type})`);
  return { bytes: Buffer.from(await res.arrayBuffer()), type };
}

async function main() {
  const mapPath = join(REPO, 'netlify', 'functions', 'image-map.json');
  const map = JSON.parse(await readFile(mapPath, 'utf8'));
  let entries = Object.entries(map);
  if (LIMIT) entries = entries.slice(0, LIMIT);

  console.log(`• bucket        : ${BUCKET}`);
  console.log(`• covers to do  : ${entries.length}${LIMIT ? ` (--limit=${LIMIT})` : ''}  x ${WIDTHS.length} sizes = ${entries.length*WIDTHS.length} objects`);
  console.log(`• sizes         : ${WIDTHS.join('px, ')}px (WebP)`);
  console.log(`• skip existing : ${FORCE ? 'no (--force)' : 'yes'}\n`);

  let done = 0, skipped = 0, failed = 0, bytesUp = 0;
  // Modest concurrency — enough to be quick, gentle enough not to get throttled.
  const CONCURRENCY = 8;
  let cursor = 0;

  async function worker() {
    while (cursor < entries.length) {
      const idx = cursor++;
      const [token, sourceUrl] = entries[idx];
      for (const width of WIDTHS) {
        const key = `${token}-${width}.webp`;
        try {
          if (!FORCE && await exists(key)) { skipped++; continue; }
          const { bytes, type } = await fetchOptimised(sourceUrl, width);
          await s3.send(new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: bytes,
            ContentType: type,
            CacheControl: 'public, max-age=31536000, immutable',
          }));
          done++; bytesUp += bytes.length;
          if (done % 200 === 0) console.log(`  …${done} objects uploaded (${(bytesUp / 1e6).toFixed(1)} MB)`);
        } catch (e) {
          failed++;
          if (failed <= 10) console.warn(`⚠ ${token}@${width}: ${e.message}`);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\nDone. uploaded=${done}  skipped=${skipped}  failed=${failed}  (${(bytesUp / 1e6).toFixed(1)} MB stored)`);
  console.log(`\nNext: verify one object loads, e.g.`);
  const [firstToken] = entries[0] || [];
  if (firstToken) console.log(`  https://img.inkandchai.in/${firstToken}-${WIDTHS[0]}.webp`);
  console.log(`\nThen flip the site over by setting IMAGE_CDN_BASE and rebuilding:`);
  console.log(`  IMAGE_CDN_BASE=https://img.inkandchai.in python3 generate_site.py`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
