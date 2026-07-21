#!/usr/bin/env node
/**
 * upload-reels.mjs — upload #InkAndChaiBookstagram reels to Supabase Storage.
 *
 * WHY: reel videos are served from Supabase's CDN, NOT from Netlify, so they
 * add ZERO Netlify bandwidth. This uploads the local .mp4 files into the public
 * `reels` bucket under the exact object names that data/social_proof.json
 * already references.
 *
 * RUN (from the repo root):
 *   SUPABASE_URL=https://lajjjjkidxyfvmnyjboy.supabase.co \
 *   SUPABASE_SERVICE_KEY=<your service_role key> \
 *   node scripts/upload-reels.mjs
 *
 * The service_role key is in your Netlify env (Site settings → Environment) or
 * Supabase dashboard → Project Settings → API → service_role. It is never
 * committed and never leaves your machine.
 *
 * Add/replace videos by editing MAP below (local filename → object name), then
 * mirror the object name in data/social_proof.json's src URLs.
 */

import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const SRC_DIR = join(REPO, 'newvideos');            // where the raw .mp4 live
const BUCKET = 'reels';

// local filename (in ./newvideos)  →  object name in the `reels` bucket
const MAP = [
  ['WHAT I TALK ABOUT WHEN I TALK ABOUT RUNNING by HARUKI MURAKAMI  The Ink and Chai (1).mp4', 'running-1.mp4'],
  ['WHAT I TALK ABOUT WHEN I TALK ABOUT RUNNING by HARUKI MURAKAMI  The Ink and Chai (2).mp4', 'running-2.mp4'],
  ['WHAT I TALK ABOUT WHEN I TALK ABOUT RUNNING by HARUKI MURAKAMI  The Ink and Chai (3).mp4', 'running-3.mp4'],
  ['WHAT I TALK ABOUT WHEN I TALK ABOUT RUNNING by HARUKI MURAKAMI  The Ink and Chai (4).mp4', 'running-4.mp4'],
  ['WHAT I TALK ABOUT WHEN I TALK ABOUT RUNNING by HARUKI MURAKAMI  The Ink and Chai.mp4',     'running-5.mp4'],
];

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('✗ Set SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment. See the header of this file.');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

async function ensureBucket() {
  // Idempotent: create the public bucket if it doesn't exist yet.
  const { data } = await supabase.storage.getBucket(BUCKET);
  if (data) return;
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: '25MB',
    allowedMimeTypes: ['video/mp4'],
  });
  if (error && !/already exists/i.test(error.message)) throw error;
  console.log(`• created public bucket "${BUCKET}"`);
}

async function main() {
  await ensureBucket();
  let ok = 0;
  for (const [localName, objName] of MAP) {
    const path = join(SRC_DIR, localName);
    let bytes;
    try { bytes = await readFile(path); }
    catch { console.warn(`⚠ skip (not found): ${localName}`); continue; }

    const { error } = await supabase.storage.from(BUCKET).upload(objName, bytes, {
      contentType: 'video/mp4',
      upsert: true,                 // re-running replaces the file
      cacheControl: '31536000',     // 1-year immutable cache at Supabase's CDN
    });
    if (error) { console.error(`✗ ${objName}: ${error.message}`); continue; }

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(objName);
    console.log(`✓ ${objName}  →  ${pub.publicUrl}  (${(bytes.length / 1e6).toFixed(1)} MB)`);
    ok++;
  }
  console.log(`\nDone: ${ok}/${MAP.length} uploaded. These URLs already match data/social_proof.json — just commit & push.`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
