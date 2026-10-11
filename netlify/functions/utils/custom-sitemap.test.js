'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeSitemap } = require('./custom-sitemap');

const BAKED = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://inkandchai.in/</loc></url>
  <url><loc>https://inkandchai.in/product/ikigai/</loc></url>
</urlset>`;

test('admin-added books are appended inside the urlset', () => {
  const { xml, added } = mergeSitemap(BAKED, [
    { slug: 'trust-fall-from-the-no-1-bestselling-author-of-better-than-the-movies', lastmod: '2026-10-04' },
    { slug: 'ikigai', lastmod: '2026-10-01' },          // already baked
    { slug: 'gone-book', lastmod: '2026-10-01' },      // deleted
    { slug: '', lastmod: null },
  ], { deleted: new Set(['gone-book']) });
  assert.equal(added, 1);
  assert.match(xml, /<url><loc>https:\/\/inkandchai\.in\/product\/trust-fall-from-the-no-1-bestselling-author-of-better-than-the-movies\/<\/loc><lastmod>2026-10-04<\/lastmod>/);
  assert.ok(xml.trim().endsWith('</urlset>'));
  assert.equal((xml.match(/<loc>/g) || []).length, 3);
});

test('nothing to add, or not a sitemap: served as it was', () => {
  assert.equal(mergeSitemap(BAKED, []).xml, BAKED);
  assert.equal(mergeSitemap('<html>oops</html>', [{ slug: 'x' }]).added, 0);
});
