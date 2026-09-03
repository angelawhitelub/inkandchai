const test = require('node:test');
const assert = require('node:assert');
const { hasBadgeTag, withBadgeTag, resolvePublisherSourced, isMissingColumn, selectTolerant } = require('./publisher-sourced');

test('withBadgeTag adds the tag without disturbing the others', () => {
  assert.strictEqual(withBadgeTag('crossword-catalog, no-cod', true), 'publisher-sourced-bestseller, crossword-catalog, no-cod');
  assert.strictEqual(withBadgeTag('', true), 'publisher-sourced-bestseller');
});

test('withBadgeTag removes the tag and leaves the rest intact', () => {
  assert.strictEqual(withBadgeTag('publisher-sourced-bestseller,crossword-catalog,no-cod', false), 'crossword-catalog, no-cod');
  assert.strictEqual(withBadgeTag('no-cod', false), 'no-cod');
  assert.strictEqual(withBadgeTag('publisher-sourced-bestseller', false), '');
});

test('withBadgeTag is idempotent and never duplicates the tag', () => {
  const once = withBadgeTag('no-cod', true);
  assert.strictEqual(withBadgeTag(once, true), once);
});

test('the admin toggle outranks the legacy tag in both directions', () => {
  // A catalogue book has no tag at all — the override is the only source.
  assert.strictEqual(resolvePublisherSourced(true, ''), true);
  // Turning it OFF must beat a tag still sitting on the custom_products row,
  // otherwise the badge could not be removed from an imported listing.
  assert.strictEqual(resolvePublisherSourced(false, 'publisher-sourced-bestseller'), false);
  // No override (pre-migration rows) keeps the old tag-driven behaviour.
  assert.strictEqual(resolvePublisherSourced(null, 'publisher-sourced-bestseller'), true);
  assert.strictEqual(resolvePublisherSourced(undefined, 'no-cod'), false);
});

test('isMissingColumn only matches a genuine missing-column error', () => {
  assert.ok(isMissingColumn({ message: 'column product_overrides.publisher_sourced does not exist' }, 'publisher_sourced'));
  // A row-level failure that happens to name the column is NOT a schema problem;
  // retrying without the column would silently discard the admin's save.
  assert.ok(!isMissingColumn({ message: 'null value in column "publisher_sourced" violates not-null' }, 'publisher_sourced'));
  assert.ok(!isMissingColumn({ message: 'permission denied' }, 'publisher_sourced'));
});

test('selectTolerant asks for the column, then replays without it', async () => {
  const asked = [];
  const res = await selectTolerant(cols => {
    asked.push(cols);
    return asked.length === 1
      ? { data: null, error: { message: 'column product_overrides.publisher_sourced does not exist' } }
      : { data: [{ slug: 'x' }], error: null };
  }, 'slug,price_inr');
  assert.deepStrictEqual(asked, ['slug,price_inr,publisher_sourced', 'slug,price_inr']);
  assert.deepStrictEqual(res.data, [{ slug: 'x' }]);
});

test('selectTolerant does not retry on an unrelated error', async () => {
  let calls = 0;
  const res = await selectTolerant(() => { calls++; return { data: null, error: { message: 'connection reset' } }; }, 'slug');
  assert.strictEqual(calls, 1);
  assert.strictEqual(res.error.message, 'connection reset');
});
