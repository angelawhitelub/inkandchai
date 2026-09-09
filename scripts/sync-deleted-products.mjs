#!/usr/bin/env node
/**
 * Refresh data/deleted_products.json from the live takedown list.
 *
 * Run this before regenerating the site. generate_site.py reads the file and
 * stops emitting those product pages, their sitemap entries, their feed entries
 * and every category card that links them — which is what turns an admin
 * takedown (a 410 served from KV) into a permanent removal from the build.
 *
 * Reads the Worker's own /deleted-products.json, so it needs no credentials and
 * reflects exactly what the edge is enforcing.
 *
 *   node scripts/sync-deleted-products.mjs [--site https://inkandchai.in]
 */
import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'data', 'deleted_products.json');
const siteArg = process.argv.indexOf('--site');
const site = (siteArg > -1 ? process.argv[siteArg + 1] : 'https://inkandchai.in').replace(/\/+$/, '');

const res = await fetch(`${site}/deleted-products.json`, { headers: { 'Cache-Control': 'no-cache' } });
if (!res.ok) {
  console.error(`Failed to read ${site}/deleted-products.json — HTTP ${res.status}`);
  process.exit(1);
}
const { slugs = [] } = await res.json();
const next = [...new Set(slugs.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean))].sort();

let prev = [];
try { prev = JSON.parse(await readFile(out, 'utf8')); } catch { /* first run */ }
await writeFile(out, JSON.stringify(next, null, 2) + '\n', 'utf8');

const added = next.filter((s) => !prev.includes(s));
const dropped = prev.filter((s) => !next.includes(s));
console.log(`data/deleted_products.json: ${next.length} slug(s) (+${added.length} / -${dropped.length})`);
for (const s of added) console.log(`  + ${s}`);
for (const s of dropped) console.log(`  - ${s} (restored)`);
