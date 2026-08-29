/**
 * The combo cover is drawn twice: once in Python for bulk creation
 * (scripts/make_combo_cover.py) and once in the browser so a bundle built in
 * the admin panel gets the same picture. Two implementations of one drawing
 * drift silently -- nobody compares a canvas preview against a webp from a
 * script run weeks earlier -- so the geometry they share is pinned here.
 */
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const py = fs.readFileSync(path.join(root, 'scripts/make_combo_cover.py'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'public/admin/index.html'), 'utf8');
const fn = fs.readFileSync(path.join(root, 'netlify/functions/admin-bundle.js'), 'utf8');

test('both renderers use the same canvas, spine and turn', () => {
  assert.match(py, /CANVAS = 1254/);
  assert.match(admin, /const BUNDLE_CANVAS = 1254;/);
  assert.match(py, /SPINE_RATIO = 0\.085/);
  assert.match(admin, /cw \* 0\.085/);
  assert.match(py, /TURN = 0\.030/);
  assert.match(admin, /height \* 0\.030/);
});

test('both renderers space a set the same way', () => {
  // Pairs breathe, larger sets close ranks. A mismatch here is the visible
  // one: the same three books would sit differently depending on which
  // renderer drew them.
  assert.match(py, /gap = 44 if n <= 2 else \(26 if n == 3 else 14\)/);
  assert.match(admin, /n <= 2 \? 44 : \(n === 3 \? 26 : 14\)/);
  assert.match(py, /margin = MARGIN_X if n <= 2 else 56/);
  assert.match(admin, /n <= 2 \? 84 : 56/);
  assert.match(py, /MARGIN_X = 84/);
});

test('both renderers trim the white margin off a cover', () => {
  // Skipping this is what makes one book look shorter than its neighbour.
  assert.match(py, /def trim_white/);
  assert.match(admin, /function trimCover/);
  // ...and both refuse a crop that would eat a mostly-white cover.
  assert.match(py, /< w \* 0\.5 or .*< h \* 0\.5/);
  assert.match(admin, /< w \* 0\.5 \|\| \(y1 - y0\) < h \* 0\.5/);
});

test('the browser can export the canvas it drew', () => {
  // Covers come from a third-party CDN. Without crossOrigin the canvas is
  // tainted and toDataURL throws, so every bundle would silently fall back to
  // a single book's cover.
  assert.match(admin, /img\.crossOrigin = 'anonymous';/);
  assert.match(admin, /canvas\.toDataURL\('image\/webp', 0\.88\)/);
});

test('a composed image is stored, not inlined into the row', () => {
  // A data URL written straight into custom_products.image_url would put a
  // ~150 KB string in every product query that touches the bundle.
  assert.match(fn, /storeComboImage/);
  assert.match(fn, /r2PutObject/);
  assert.match(fn, /image_url: composed \|\| body\.image_url/);
});

test('a failed image never blocks the bundle', () => {
  // The listing is the valuable thing; the picture can be replaced later.
  const body = fn.slice(fn.indexOf('async function storeComboImage'), fn.indexOf('exports.handler'));
  assert.match(body, /return null;/);
  assert.match(body, /catch \(err\)/);
});
