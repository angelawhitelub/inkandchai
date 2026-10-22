#!/usr/bin/env node
/**
 * Mirror the admin-written catalogue copy into data/catalog_content.json, so the
 * next `npm run build` bakes it into the product pages and feed.xml.
 *
 * The live site already shows it (the Worker applies it from KV); this is what
 * makes it permanent and puts it in the Merchant feed. Reads the public
 * /catalog-content.json the Worker serves -- nothing on it is private, it is
 * text already shown on the product pages.
 *
 *   node scripts/sync-catalog-content.mjs [--site https://inkandchai.in]
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'data', 'catalog_content.json');
const siteArg = process.argv.indexOf('--site');
const site = (siteArg > -1 ? process.argv[siteArg + 1] : 'https://inkandchai.in').replace(/\/+$/, '');

const res = await fetch(`${site}/catalog-content.json`, { headers: { 'Cache-Control': 'no-cache' } });
if (!res.ok) {
  console.error(`Failed to read ${site}/catalog-content.json — HTTP ${res.status}`);
  process.exit(1);
}
const { items = {} } = await res.json();
const sorted = Object.fromEntries(Object.keys(items).sort().map((k) => [k, items[k]]));
await writeFile(out, JSON.stringify({ items: sorted }, null, 2) + '\n');
console.log(`Wrote ${Object.keys(sorted).length} catalogue books' copy to data/catalog_content.json`);
