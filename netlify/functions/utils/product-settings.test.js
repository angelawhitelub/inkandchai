const test = require('node:test');
const assert = require('node:assert');
const { handlingDays, normalizeRow, isMissingTable, fetchSettings, MAX_HANDLING_DAYS } = require('./product-settings');

test('handling time normalises "no opinion" and "default" to the same thing', () => {
  // Blank and 0 both mean the store default, so the storefront only has to test
  // for null instead of distinguishing "unset" from "explicitly zero".
  assert.strictEqual(handlingDays(''), null);
  assert.strictEqual(handlingDays(null), null);
  assert.strictEqual(handlingDays(0), null);
  assert.strictEqual(handlingDays('0'), null);
  assert.strictEqual(handlingDays('2'), 2);
  assert.strictEqual(handlingDays(2.4), 2);
});

test('handling time is clamped, never negative or absurd', () => {
  assert.strictEqual(handlingDays(-5), null);      // clamps to 0, which is "default"
  assert.strictEqual(handlingDays(1000), MAX_HANDLING_DAYS);
  assert.strictEqual(handlingDays('abc'), null);
});

test('normalizeRow drops non-positive prices so they cannot zero a product out', () => {
  assert.deepStrictEqual(normalizeRow({ slug: 'A-Book', price_inr: '299.00', original_price_inr: 0, handling_days: 0 }), {
    slug: 'a-book', price_inr: 299, original_price_inr: null, handling_days: null,
  });
  assert.strictEqual(normalizeRow({ price_inr: 10 }), null);
});

test('isMissingTable separates a missing migration from a real failure', () => {
  assert.ok(isMissingTable({ code: '42P01', message: 'relation "public.product_settings" does not exist' }));
  assert.ok(!isMissingTable({ message: 'JWT expired' }));
  assert.ok(!isMissingTable({ message: 'permission denied for table product_settings' }));
});

test('fetchSettings returns {} rather than throwing when the table is missing', async () => {
  // The whole point: an unapplied migration must cost the new fields only, not
  // take every price override off the storefront.
  const supabase = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { code: '42P01', message: 'relation "product_settings" does not exist' } }) }) }) };
  assert.deepStrictEqual(await fetchSettings(supabase, ['x']), {});
});

test('fetchSettings keys rows by lowercase slug', async () => {
  const rows = [{ slug: 'Some-Book-NG-HI', price_inr: '349', original_price_inr: '699', handling_days: 3 }];
  const supabase = { from: () => ({ select: () => ({ in: async () => ({ data: rows, error: null }) }) }) };
  const out = await fetchSettings(supabase, ['some-book-ng-hi']);
  assert.deepStrictEqual(out, { 'some-book-ng-hi': { slug: 'some-book-ng-hi', price_inr: 349, original_price_inr: 699, handling_days: 3 } });
});

test('an empty slug list short-circuits without querying', async () => {
  let called = false;
  const supabase = { from: () => { called = true; return { select: () => ({}) }; } };
  assert.deepStrictEqual(await fetchSettings(supabase, []), {});
  assert.strictEqual(called, false);
});
