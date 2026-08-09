// ── Shopping-feed image + slug filtering ─────────────────────────────────────
// The rules live in feed-image-filter.json so generate_site.py (feed.xml) and
// the custom-products feed functions read ONE list and cannot drift apart. Three
// copies of the same regex previously existed — Python, custom-products-feed.js
// and custom-products-feed-bulk.js — and all three missed the same images.
//
// See the _comment block in the JSON for why each pattern is there.

const rules = require('./feed-image-filter.json');

const PLACEHOLDER_IMAGE_RE =
  new RegExp(`(${rules.placeholder_image_patterns.join('|')})`, 'i');

const EXCLUDED_SLUGS = new Set(Object.keys(rules.excluded_slugs || {}));

// True when the image is a branded placeholder / "coming soon" card rather than
// a real cover. Google reads those as "Promotional overlay on image".
function isPlaceholderImage(url) {
  return PLACEHOLDER_IMAGE_RE.test(String(url || ''));
}

// True when this product must not be submitted at all — its image is a genuine
// policy breach with no clean replacement yet.
function isExcludedSlug(slug) {
  return EXCLUDED_SLUGS.has(String(slug || ''));
}

// One call for both checks, for feed builders that just want a yes/no.
function skipFromFeed({ slug, imageUrl }) {
  if (isExcludedSlug(slug)) return 'excluded-slug';
  if (!imageUrl) return 'no-image';
  if (isPlaceholderImage(imageUrl)) return 'placeholder-image';
  return null;
}

module.exports = {
  PLACEHOLDER_IMAGE_RE, EXCLUDED_SLUGS,
  isPlaceholderImage, isExcludedSlug, skipFromFeed, rules,
};
