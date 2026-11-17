'use strict';
// Sponsored bundle on the frequently-bought-together panel (owner, 16 Nov 2026).
const test = require('node:test');
const assert = require('node:assert/strict');

const { sponsoredFor, sponsoredGroupFor, SPONSORED_GROUPS } = require('../frequently-bought')._test;

// The live list is empty since 18 Nov 2026 (owner removed the engineering
// group); the mechanism is tested with a fixture group.
const GROUPS = [{ slugs: ['ai-book', 'ddia-book', 'sdi-book'], title: 'Shelf', sub: 'Sponsored' }];
const [AI, DDIA, SDI] = GROUPS[0].slugs;
const book = (slug, price = 999) => ({ slug, aliases: [slug], url: `/product/${slug}/`, title: slug, price, originalPrice: 2000 });
const till = (overrides = {}) => async (lines) => ({
  cart: lines.map((l) => ({ slug: l.slug, qty: 1, price: 1000, ...(overrides[l.slug] || {}) })),
});

test('no sponsored group is live', () => {
  assert.deepEqual(SPONSORED_GROUPS, []);
  assert.equal(sponsoredGroupFor(book('system-design-interview-vol-1-vol-2-combo-set-by-alex-xu-an-insiders-guide-to-sy')), null);
});

test('the three fixture books are one group', () => {
  for (const slug of [AI, DDIA, SDI]) assert.ok(sponsoredGroupFor(book(slug), GROUPS), slug);
  assert.equal(sponsoredGroupFor(book('some-other-book'), GROUPS), null);
});

test('a hidden or taken-down book is never a sponsored pick', async () => {
  const out = await sponsoredFor(book(AI), [], {
    groups: GROUPS, removed: new Set([SDI]), supabase: null,
    customBySlugs: async (s) => s.map((x) => book(x)), resolveCartPrices: till(),
  });
  assert.deepEqual(out.picks.map((p) => p.slug), [DDIA]);
});

test('each page gets the other two, at the till price', async () => {
  for (const base of [AI, DDIA, SDI]) {
    const out = await sponsoredFor(book(base), [], {
      groups: GROUPS, supabase: null,
      customBySlugs: async (slugs) => slugs.map((s) => book(s, 1503)),
      resolveCartPrices: till({ [AI]: { price: 1483 } }),
    });
    const slugs = out.picks.map((p) => p.slug);
    assert.equal(slugs.length, 2, base);
    assert.ok(!slugs.includes(base), base);
    for (const p of out.picks) {
      assert.equal(p.sponsored, true);
      assert.equal(p.price, p.slug === AI ? 1483 : 1000);   // the till's number, not the stored 1503
    }
  }
});

test('sold-out or taken-down books are left out; none left means no sponsored panel', async () => {
  const deps = (o) => ({ groups: GROUPS, supabase: null, customBySlugs: async (s) => s.map((x) => book(x)), resolveCartPrices: till(o) });
  let out = await sponsoredFor(book(AI), [], deps({ [DDIA]: { _sold_out: true } }));
  assert.deepEqual(out.picks.map((p) => p.slug), [SDI]);
  out = await sponsoredFor(book(AI), [], deps({ [DDIA]: { _sold_out: true }, [SDI]: { _removed: true } }));
  assert.equal(out, null);
});

test('no till price, no sponsored panel', async () => {
  const out = await sponsoredFor(book(AI), [], {
    groups: GROUPS, supabase: null,
    customBySlugs: async (s) => s.map((x) => book(x)),
    resolveCartPrices: async () => { throw new Error('db down'); },
  });
  assert.equal(out, null);
});

test('a taken-down page is recognised by slug or alias, whatever the case', () => {
  const { isRemoved } = require('../frequently-bought')._test;
  const removed = new Set(['vol-2-system-design-interview-81725']);
  assert.equal(isRemoved({ slug: 'vol-2-system-design-interview-81725' }, removed), true);
  assert.equal(isRemoved({ slug: 'x', aliases: ['VOL-2-System-Design-Interview-81725'] }, removed), true);
  assert.equal(isRemoved({ slug: 'designing-data-intensive-applications-by-martin-kleppmann' }, removed), false);
});
