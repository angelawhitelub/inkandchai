const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('./cod-rules');

// A minimal Supabase stand-in: from(table).select().or(filter) → rows whose slug matches.
function fakeDb(rows, { error } = {}) {
  return {
    from: (table) => ({
      select: () => ({
        or: async (filter) => {
          if (error) return { data: null, error };
          assert.equal(table, C.TABLE);
          const wanted = new Set(filter.split(',').map((f) => f.replace(/^slug\.ilike\./, '')));
          return { data: rows.filter((r) => wanted.has(r.slug.toLowerCase())), error: null };
        },
      }),
    }),
  };
}

test('a rule switches COD off with its note, or the default note when blank', async () => {
  const db = fakeDb([{ slug: 'Rare-Book', note: '  Brought   on demand <b>only</b>. ' }, { slug: 'plain', note: null }]);
  const rules = await C.codRulesFor(db, ['rare-book', 'plain', 'other']);
  assert.deepEqual(rules, { 'rare-book': 'Brought on demand only .', plain: C.DEFAULT_NOTE });
  assert.match(C.DEFAULT_NOTE, /publisher on demand/);
  assert.match(C.DEFAULT_NOTE, /partial amount/);
});

test('before the migration nothing is switched off and nothing throws', async () => {
  const db = fakeDb([], { error: { code: '42P01', message: 'relation "product_cod_rules" does not exist' } });
  assert.deepEqual(await C.codRulesFor(db, ['a']), {});
});

test('slugs that could break the filter are dropped', () => {
  assert.equal(C.cleanSlug(' Some-Book '), 'some-book');
  assert.equal(C.cleanSlug('a,slug.ilike.%'), '');
  assert.equal(C.cleanSlug('a/b'), '');
});

test('the page notice is escaped and marked so it is never doubled', () => {
  const html = C.codOffNoticeHtml('<script>x</script> & more');
  assert.match(html, /data-cod-off="1"/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt; &amp; more/);
});
