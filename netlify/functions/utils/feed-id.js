/**
 * The `g:id` a custom/bulk product carries in its Merchant feed.
 *
 * Google caps g:id at 50 characters. The old rule replaced any over-long id
 * with a bare SHA-1 (`cp-7028c1d20f0a498f462f`), which is unique but tells you
 * nothing — you cannot find the product in Merchant Center by searching its
 * slug, and a disapproval e-mail names an id you have to reverse-engineer.
 *
 * Instead, keep as much of the slug as fits and disambiguate with a short hash
 * suffix, so the id stays readable AND stays unique:
 *
 *   cp-<slug>                                    when that is <= 50 chars
 *   cp-<slug truncated to 38, at a hyphen>-<8 hex of sha1(slug)>   otherwise
 *
 * 3 ("cp-") + 38 + 1 ("-") + 8 = 50 exactly, so the result never overflows.
 *
 * The static catalogue (feed.xml) uses the bare slug and does not come through
 * here.
 */

const crypto = require('crypto');

const MAX_ID_LEN = 50;
const HASH_LEN = 8;
// "cp-" + slug + "-" + hash  ==  50
const MAX_SLUG_LEN = MAX_ID_LEN - 3 - 1 - HASH_LEN;

function shortHash(slug) {
  return crypto.createHash('sha1').update(String(slug)).digest('hex').slice(0, HASH_LEN);
}

/**
 * Trim to at most `max` chars, preferring a hyphen boundary so the id reads as
 * whole words. Falls back to a hard cut when the first `max` chars hold no
 * hyphen (or the only hyphen is so early that trimming would throw the slug
 * away) — a hard cut is still readable, and the hash keeps it unique either way.
 */
function trimSlug(slug, max = MAX_SLUG_LEN) {
  const s = String(slug).slice(0, max);
  const cut = s.lastIndexOf('-');
  // Only honour the boundary if it keeps most of the budget; otherwise a slug
  // like "a-verylongsinglewordwithoutanyhyphens…" would collapse to "a".
  if (cut >= Math.floor(max * 0.6)) return s.slice(0, cut);
  return s.replace(/-+$/, '');
}

/** The id this slug goes out under today. Always <= 50 chars. */
function feedId(slug) {
  const s = String(slug == null ? '' : slug).trim();
  if (!s) return '';
  const plain = `cp-${s}`;
  if (plain.length <= MAX_ID_LEN) return plain;
  return `cp-${trimSlug(s)}-${shortHash(s)}`;
}

/**
 * The opaque id long slugs used to go out under, before this change. Kept so
 * anything matching an incoming offer id (Google Ads cart data, promotions)
 * still recognises products Merchant Center ingested under the old scheme.
 */
function legacyFeedId(slug) {
  const s = String(slug == null ? '' : slug).trim();
  if (!s) return '';
  const plain = `cp-${s}`;
  if (plain.length <= MAX_ID_LEN) return plain;
  return 'cp-' + crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);
}

/**
 * The `g:id` a baked catalogue book carries in /feed.xml -- a port of the rule
 * in generate_site.py, which writes that feed. The bare slug; when it is over
 * 50 characters, the title part is cut and the trailing shopify-id suffix kept,
 * so two books never collide:
 *
 *   prefix, suffix = slug.rsplit("-", 1)
 *   prefix[:50 - 1 - len(suffix)].rstrip("-") + "-" + suffix
 *
 * Kept byte-for-byte with the Python: the admin shows this as the book's Google
 * item id, and an id that differs from the feed's by one character finds
 * nothing in Merchant Center.
 */
function catalogueFeedId(slug) {
  const s = String(slug == null ? '' : slug);
  if (s.length <= MAX_ID_LEN) return s;
  const cut = s.lastIndexOf('-');
  if (cut < 0) return s.slice(0, MAX_ID_LEN);
  const prefix = s.slice(0, cut);
  const suffix = s.slice(cut + 1);
  const maxPrefix = MAX_ID_LEN - 1 - suffix.length;
  // Python slicing with a negative bound counts from the end; mirror it.
  const cutPrefix = maxPrefix >= 0 ? prefix.slice(0, maxPrefix) : prefix.slice(0, Math.max(0, prefix.length + maxPrefix));
  return cutPrefix.replace(/-+$/, '') + '-' + suffix;
}

module.exports = { feedId, legacyFeedId, catalogueFeedId, MAX_ID_LEN, MAX_SLUG_LEN };
