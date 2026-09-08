'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { renderSlide } = require('../../netlify/functions/utils/banner-slide');
const { BUILTIN_SLOTS, isBuiltin } = require('../../netlify/functions/utils/banner-slots');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

test('every built-in slot exists in the generated homepage or the generator', () => {
  // The homepage hides a slide by matching data-banner-slot. A slot named here
  // that is not in the markup is a Hide button that silently does nothing.
  const src = fs.readFileSync(path.join(ROOT, 'generate_site.py'), 'utf8');
  for (const b of BUILTIN_SLOTS) {
    assert.ok(src.includes(`data-banner-slot="${b.slot}"`),
      `${b.slot} is offered in the admin but no slide carries it`);
  }
});

test('the homepage can actually rebuild its carousel', () => {
  // The old carousel captured its slides in a NodeList at load, so an injected
  // banner was invisible to it. These are the pieces that make injection work.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('function setupCarousel'), 'carousel must be re-runnable');
  assert.ok(html.includes('loadPublishedBanners'), 'homepage must fetch published banners');
  assert.ok(html.includes('/.netlify/functions/site-banners'), 'fetch target missing');
  assert.ok(!/const slides = carousel\.querySelectorAll\('\.promo-slide'\);\s*\n\s*const dots\s+= carousel\.querySelectorAll/.test(html),
    'the old capture-once carousel is still in the built page');
});

test('a published banner is rendered from fields, so stored text cannot inject markup', () => {
  // site-banners stores fields and re-renders on read. This is what makes that
  // safe: a row full of markup comes back as inert text.
  const nasty = {
    eyebrow: '<script>alert(1)</script>',
    title_line1: 'A', title_accent: '" onload="x()', title_line3: 'B',
    subtitle: 'Tom & Jerry', cta_label: 'Go', cta_href: '/bestsellers/',
    cta_secondary: 'More', cta_secondary_href: '/bestsellers/',
    stats: [{ num: '2', label: 'books' }],
  };
  const html = renderSlide(nasty, [{ slug: 'x-1', title: 'T', img: 'i.jpg' }]);
  assert.ok(!html.includes('<script>'));
  assert.ok(!/onload="/.test(html));
  assert.ok(html.includes('Tom &amp; Jerry'));
});

test('built-ins are recognised, published slots are not', () => {
  assert.ok(isBuiltin('builtin:sale'));
  assert.ok(!isBuiltin('custom:abc123'));
  assert.ok(!isBuiltin(''));
});

test('every built-in slot id is unique', () => {
  const slots = BUILTIN_SLOTS.map(b => b.slot);
  assert.strictEqual(new Set(slots).size, slots.length);
});
