/**
 * The "Genuine — Publisher Sourced" badge.
 *
 * Originally this was purely a `publisher-sourced-bestseller` tag written by the
 * Crossword importer onto custom_products rows, so it could only ever exist on
 * admin-created listings — a catalogue book has no custom_products row to hold a
 * tag. The badge is now an admin toggle for EVERY product, so the authoritative
 * value lives in product_overrides.publisher_sourced, which exists for catalogue
 * and custom slugs alike.
 *
 * Resolution order everywhere: the override column when it is non-null, else the
 * legacy tag. Nulling the column (never written by the admin, only by rows that
 * predate the migration) keeps the old tag-driven behaviour intact.
 */
const BADGE_TAG = 'publisher-sourced-bestseller';
const BADGE_TAG_RE = /publisher-sourced-bestseller/i;

function hasBadgeTag(tags) {
  return BADGE_TAG_RE.test(String(tags || ''));
}

/** Add or remove the badge tag, preserving every other tag and their order. */
function withBadgeTag(tags, on) {
  const parts = String(tags || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .filter(t => !BADGE_TAG_RE.test(t));
  if (on) parts.unshift(BADGE_TAG);
  return parts.join(', ');
}

/** null/undefined override → fall back to the tag. */
function resolvePublisherSourced(overrideValue, tags) {
  if (overrideValue === true || overrideValue === false) return overrideValue;
  return hasBadgeTag(tags);
}

/**
 * True when PostgREST rejected the query because `column` is not in the table.
 * Callers use this to retry without an optional column instead of failing: a
 * missing migration must not take every price override off the storefront.
 */
function isMissingColumn(error, column) {
  const msg = String((error && error.message) || '');
  return msg.includes(column) && /does not exist|could not find/i.test(msg);
}

/**
 * Run a PostgREST select that wants `publisher_sourced`, retrying once without
 * it if the column is not there yet. `run` takes the column list and returns the
 * usual `{ data, error }`.
 */
async function selectTolerant(run, columns, column = 'publisher_sourced') {
  const cols = String(columns).split(',').map(c => c.trim()).filter(Boolean);
  const withColumn = cols.includes(column) ? cols : [...cols, column];
  const first = await run(withColumn.join(','));
  if (!first.error || !isMissingColumn(first.error, column)) return first;
  return run(cols.filter(c => c !== column).join(','));
}

module.exports = {
  BADGE_TAG,
  hasBadgeTag,
  withBadgeTag,
  resolvePublisherSourced,
  isMissingColumn,
  selectTolerant,
};
