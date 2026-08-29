/**
 * The reel strip carries two kinds of thing now: unboxing clips, and stills —
 * a screenshot of what a customer actually said. They share one manifest, one
 * strip and one viewer, which is where the sharp edges are.
 */
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const reelsJs = fs.readFileSync(path.join(root, 'public/js/reels.js'), 'utf8');
const store = fs.readFileSync(path.join(root, 'netlify/functions/utils/site-reels-store.js'), 'utf8');
const upload = fs.readFileSync(path.join(root, 'netlify/functions/upload-site-reel.js'), 'utf8');
const toml = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');

test('the manifest keeps the kind it was given', () => {
  // It used to hard-code 'video' on read, which silently rewrote every stored
  // type: a still could be uploaded and never read back as one.
  assert.doesNotMatch(store, /^\s*type: 'video',$/m);
  assert.match(store, /=== 'image' \? 'image' : 'video'/);
});

test('a still is not mistaken for a video by its file extension', () => {
  // isVideo's regex would otherwise be asked about a .webp and answer on the
  // strength of the explicit type alone.
  const isImage = reelsJs.slice(reelsJs.indexOf('var isImage'), reelsJs.indexOf('// ── One-time styles'));
  assert.match(isImage, /jpe\?g\|png\|webp\|gif/);
  assert.match(isImage, /if \(isImage\(it\)\) return false;/);
});

test('the viewer tolerates a slide with no video element', () => {
  // setActive used to dereference querySelector('video') unconditionally. One
  // screenshot in the strip would have broken scrolling for every reel after it.
  const setActive = reelsJs.slice(reelsJs.indexOf('function setActive'), reelsJs.indexOf('function goTo'));
  assert.match(setActive, /if \(!v\) return;/);
  assert.match(setActive, /\} else if \(v\) \{/);
  assert.doesNotMatch(setActive, /querySelector\('video'\)\.getAttribute/);
});

test('a still gets no play triangle', () => {
  // A ▶ over a screenshot promises a video that never starts.
  const tile = reelsJs.slice(reelsJs.indexOf('function tileHtml'), reelsJs.indexOf('function mount'));
  assert.match(tile, /var badge = still \? '' :/);
});

test('stills reach the strip at all', () => {
  const normalise = reelsJs.slice(reelsJs.indexOf('function normalise'), reelsJs.indexOf('function mergeReels'));
  assert.match(normalise, /isVideo\(it\) \|\| isImage\(it\)/);
});

test('an oversized screenshot is refused rather than truncated', () => {
  assert.match(upload, /MAX_IMAGE_BYTES = 3 \* 1024 \* 1024/);
  assert.match(upload, /Image is over the 3 MB upload limit/);
  assert.match(upload, /IMAGE_TYPES = \{ 'image\/webp'/);
});

// ── Hiding the built-in reels ───────────────────────────────────────────────

test('hiding a built-in reel does not drop the uploaded ones', () => {
  // Both halves live in one manifest object. A blind write of either would
  // wipe the other — un-hiding every built-in the next time anyone uploads.
  assert.match(store, /async function writeSiteReels\(items\) \{\s*\n\s*const current = await readManifest\(\);/);
  assert.match(store, /async function writeHiddenReels\(hidden\) \{\s*\n\s*const current = await readManifest\(\);/);
});

test('only built-in reels can be hidden by src', () => {
  // An uploaded reel is deleted outright; hiding applies to the baked-in set.
  const merge = reelsJs.slice(reelsJs.indexOf('function mergeReels'), reelsJs.indexOf('function sameReels'));
  assert.match(merge, /var kept = fixedReels\.filter/);
  assert.match(merge, /return kept\.concat\(normalise\(extra\)\)/);
});

test('the storefront is told what is hidden', () => {
  const site = fs.readFileSync(path.join(root, 'netlify/functions/site-reels.js'), 'utf8');
  assert.match(site, /JSON\.stringify\(\{ items, hidden \}\)/);
  // Even the degraded response carries the key, so the client never reads
  // undefined and shows a reel the shop has taken down.
  assert.match(site, /items: \[\], hidden: \[\]/);
  assert.match(reelsJs, /mergeReels\(data && data\.items, data && data\.hidden\)/);
});

test('the admin function can actually read the built-in list', () => {
  // It is a build-time data file; without this it is absent from the bundle
  // and the panel silently shows nothing to hide.
  assert.match(toml, /included_files = \[.*data\/social_proof\.json.*\]/);
  const admin = fs.readFileSync(path.join(root, 'netlify/functions/admin-site-reels.js'), 'utf8');
  assert.match(admin, /social_proof\.json/);
  assert.match(admin, /restore/);
});

test('no reel is baked into the published pages any more', () => {
  // The strip is managed from the admin panel. A reel listed here ships inside
  // every product page and can then only be hidden, never deleted, without a
  // rebuild -- which is exactly the trap the five originals were in.
  const social = JSON.parse(fs.readFileSync(path.join(root, 'data/social_proof.json'), 'utf8'));
  assert.deepEqual(social.items, [], 'built-in reels are managed in the admin panel, not in this file');
  // Both renderers read `.items`, so an empty list has to be safe in both.
  const productPage = fs.readFileSync(path.join(root, 'netlify/functions/product-page.js'), 'utf8');
  assert.match(productPage, /require\('\.\.\/\.\.\/data\/social_proof\.json'\)\.items \|\| \[\]/);
  const gen = fs.readFileSync(path.join(root, 'generate_site.py'), 'utf8');
  assert.match(gen, /_social\.get\("items"\) or \[\]/);
});

test('the strip says something sensible when it is empty', () => {
  // With no built-ins, a shop that has uploaded nothing yet renders this.
  assert.match(reelsJs, /if \(!reels\.length\) \{/);
  assert.match(reelsJs, /collecting unboxing reels from our readers/);
});
