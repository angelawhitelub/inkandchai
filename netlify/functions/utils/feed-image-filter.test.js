const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isPlaceholderImage, isExcludedSlug, skipFromFeed, rules } = require('./feed-image-filter');

// Google flagged 73 products for "Promotional overlay on image" on 2026-08-09.
// 61 were the 99 Bookstore "IMAGE COMING SOON" card — a competitor's logo plus
// "LEARN MORE, GROW MORE" — re-uploaded to Shopify under generic
// ChatGPT_Image_May_25_2026_* filenames, which the old word-based patterns did
// not match. Only the catalog tag filters kept them out of the feed.

const CHATGPT_PLACEHOLDER =
  'https://cdn.shopify.com/s/files/1/0777/8100/8701/files/ChatGPT_Image_May_25_2026_03_28_31_PM_3e248116-4361-4b5d-ac22-8771f6f5b32d.png?v=1783023164';

test('the re-uploaded 99 Bookstore placeholder is caught by filename', () => {
  assert.ok(isPlaceholderImage(CHATGPT_PLACEHOLDER));
});

test('the legacy placeholder patterns still work', () => {
  for (const u of ['https://x/99bookstores.com_card.jpg',
                   'https://x/coming-soon.png', 'https://x/coming_soon.png',
                   'https://x/no-image.jpg', 'https://x/placeholder.webp',
                   'https://x/image-not-available.jpg']) {
    assert.ok(isPlaceholderImage(u), u);
  }
});

test('real covers are never mistaken for placeholders', () => {
  for (const u of ['https://cdn.shopify.com/s/files/1/0777/8100/8701/files/91bYsX41DVL._SL1500.jpg',
                   'https://inkandchai.in/images/the-mistake-elle-kennedy-off-campus.webp',
                   'https://cdn.shopify.com/s/files/1/0777/8100/8701/files/9789386538192.jpg']) {
    assert.equal(isPlaceholderImage(u), false, u);
  }
});

test('a missing image is not reported as a placeholder', () => {
  assert.equal(isPlaceholderImage(''), false);
  assert.equal(isPlaceholderImage(null), false);
  assert.equal(isPlaceholderImage(undefined), false);
});

// ── Excluded slugs ─────────────────────────────────────────────────────────
test('the three genuine breaches are excluded', () => {
  assert.ok(isExcludedSlug('ink-chai-library-box-52733'));
  assert.ok(isExcludedSlug('contemporary-glamour-opulent-interiors-from-53725'));
  assert.ok(isExcludedSlug('the-deal-the-mistake-the-score-elle-kennedy-off-campus-combo'));
});

test('the truncated Merchant Center id is excluded too', () => {
  // g:id is capped at 50 chars, so the id in an issue report is not the slug.
  // Missing this is why the combo survived the first pass.
  assert.ok(isExcludedSlug('the-deal-the-mistake-the-score-elle-kennedy-combo'));
});

test('ordinary products are not excluded', () => {
  for (const s of ['atomic-habits-16989', 'who-moved-my-cheese-21341', '', null]) {
    assert.equal(isExcludedSlug(s), false, String(s));
  }
});

// ── skipFromFeed: the single decision both feeds make ──────────────────────
test('skipFromFeed reports why an item is withheld', () => {
  assert.equal(skipFromFeed({ slug: 'ink-chai-library-box-52733', imageUrl: 'https://x/ok.jpg' }), 'excluded-slug');
  assert.equal(skipFromFeed({ slug: 'fine', imageUrl: CHATGPT_PLACEHOLDER }), 'placeholder-image');
  assert.equal(skipFromFeed({ slug: 'fine', imageUrl: '' }), 'no-image');
});

test('a good product is kept', () => {
  assert.equal(skipFromFeed({ slug: 'atomic-habits-16989', imageUrl: 'https://cdn.shopify.com/x/91bYsX41DVL._SL1500.jpg' }), null);
});

test('an excluded slug is withheld even with a perfectly good image', () => {
  // The breach is the image content, which no URL test can see.
  assert.ok(skipFromFeed({ slug: 'contemporary-glamour-opulent-interiors-from-53725',
                           imageUrl: 'https://cdn.shopify.com/x/real-cover.jpg' }));
});

// ── The Python generator must read the same file ───────────────────────────
test('generate_site.py loads these rules rather than keeping its own copy', () => {
  const py = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'generate_site.py'), 'utf8');
  assert.ok(py.includes('feed-image-filter.json'),
    'generate_site.py must load feed-image-filter.json');
  assert.ok(py.includes('placeholder_image_patterns') && py.includes('excluded_slugs'),
    'generate_site.py must build its regex and slug set from the shared file');
  // The old hardcoded regex must be gone, or the two feeds can drift again.
  assert.equal(/_PLACEHOLDER_IMAGE_RE = re\.compile\(r'\(99bookstores/.test(py), false,
    'generate_site.py still has its own hardcoded pattern list');
});

test('both feed functions use the shared filter', () => {
  for (const f of ['custom-products-feed.js', 'custom-products-feed-bulk.js']) {
    const src = fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
    assert.ok(src.includes("require('./utils/feed-image-filter')"), `${f} must require the shared filter`);
    assert.equal(/99bookstores\\\.com_\|coming/.test(src), false, `${f} still has its own inline regex`);
  }
});

test('every pattern in the shared file is a valid regex', () => {
  for (const p of rules.placeholder_image_patterns) {
    assert.doesNotThrow(() => new RegExp(p), `bad pattern: ${p}`);
  }
});

test('every excluded slug carries a written reason', () => {
  // So nobody deletes an entry without knowing what it was protecting against.
  for (const [slug, reason] of Object.entries(rules.excluded_slugs)) {
    assert.ok(typeof reason === 'string' && reason.length > 20, `no reason given for ${slug}`);
  }
});
