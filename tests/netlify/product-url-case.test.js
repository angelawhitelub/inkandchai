'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Cloudflare serves static assets case-SENSITIVELY. Netlify did not, which is
 * why this stayed hidden until the migration: 18 product pages were generated
 * into directories like "moonwalk-by-michael-jackson-CKSON" while the feed,
 * sitemap and catalogue JS all pointed at ".../-ckson". Every one of those was
 * a live Merchant Center destination returning 404.
 *
 * It is invisible on a Mac twice over -- APFS is case-insensitive, so both the
 * shell and Node happily open the "wrong" name, and git never sees the rename
 * so the stale casing is committed forever. Only a case-EXACT comparison
 * against the real directory names catches it, which is what this file does.
 */

const ROOT = path.join(__dirname, '..', '..');
const PRODUCT_DIR = path.join(ROOT, 'public', 'product');

// readdirSync reports the name as stored on disk, so this is the ground truth
// even on a case-insensitive filesystem.
const actualSlugs = new Set(
  fs.readdirSync(PRODUCT_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
);

function slugsReferencedIn(file) {
  const text = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
  const out = new Set();
  for (const m of text.matchAll(/https:\/\/inkandchai\.in\/product\/([^/<"\s]+)\//g)) {
    out.add(decodeURIComponent(m[1]));
  }
  return out;
}

function assertAllResolve(file) {
  const referenced = slugsReferencedIn(file);
  assert.ok(referenced.size > 100, `${file} should reference many products, saw ${referenced.size}`);

  const missing = [...referenced].filter(s => !actualSlugs.has(s));
  // Separate the case-only mismatches, because they are the ones that look fine
  // on a Mac and 404 in production -- naming them makes the failure obvious.
  const caseOnly = missing.filter(s => {
    const lower = s.toLowerCase();
    return [...actualSlugs].some(a => a.toLowerCase() === lower);
  });
  const gone = missing.filter(s => !caseOnly.includes(s));

  assert.deepStrictEqual(caseOnly, [],
    `${file} references these slugs with the wrong CASE (they 404 on Cloudflare): ${caseOnly.join(', ')}`);
  assert.deepStrictEqual(gone, [],
    `${file} references products with no generated page: ${gone.join(', ')}`);
}

test('every product URL in feed.xml has a case-exact generated page', () => {
  assertAllResolve('feed.xml');
});

test('every product URL in sitemap.xml has a case-exact generated page', () => {
  assertAllResolve('sitemap.xml');
});

test('every /product/ redirect target has a case-exact generated page', () => {
  const text = fs.readFileSync(path.join(ROOT, 'public', '_redirects'), 'utf8');
  const targets = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('/')) continue;
    const to = line.trim().split(/\s+/)[1] || '';
    const m = to.match(/^\/product\/([^/]+)\/?$/);
    if (m) targets.push(decodeURIComponent(m[1]));
  }
  assert.ok(targets.length > 0, 'expected some /product/ redirect targets');
  const broken = targets.filter(s => !actualSlugs.has(s));
  assert.deepStrictEqual(broken, [],
    `_redirects sends traffic to pages that do not exist: ${broken.join(', ')}`);
});

test('product slugs are lowercase, apart from the known hardcoded override', () => {
  // make_slug() lowercases the shopify_id suffix. The one exception is a
  // hardcoded override in generate_site.py whose uppercase spelling the feed,
  // sitemap and catalogue JS all agree on. Anything else with a capital letter
  // is the old bug coming back.
  const KNOWN_UPPERCASE = new Set(['5-hindi-bestsellers-combo-set-of-5-books-MBO-5']);
  const unexpected = [...actualSlugs].filter(s => /[A-Z]/.test(s) && !KNOWN_UPPERCASE.has(s));
  assert.deepStrictEqual(unexpected.sort(), [],
    `generated product directories must be lowercase: ${unexpected.join(', ')}`);
});
