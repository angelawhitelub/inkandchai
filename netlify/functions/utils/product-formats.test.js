/**
 * The sibling-edition path in product-formats, which no amount of live poking
 * can reach until two books are actually linked. A stub stands in for Supabase.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const FN = path.join(__dirname, '..', 'product-formats.js');
const SUPA = require.resolve('@supabase/supabase-js');

/**
 * `db` maps table name → the rows a query on it returns.
 * Enough of the PostgREST builder to satisfy the endpoint, no more.
 */
function stubSupabase(db) {
  const client = {
    from(table) {
      const rows = db[table];
      const q = {
        _rows: rows instanceof Error ? rows : (rows || []),
        select() { return q; },
        eq() { return q; },
        in(_col, vals) {
          if (!(q._rows instanceof Error)) {
            q._rows = q._rows.filter(r => vals.includes(r.slug));
          }
          return q;
        },
        order() { return q; },
        limit() { return q; },
        async maybeSingle() {
          if (q._rows instanceof Error) return { data: null, error: { message: q._rows.message } };
          return { data: q._rows[0] || null, error: null };
        },
        then(res, rej) {
          const out = q._rows instanceof Error
            ? { data: null, error: { message: q._rows.message } }
            : { data: q._rows, error: null };
          return Promise.resolve(out).then(res, rej);
        },
      };
      return q;
    },
  };
  return client;
}

function loadHandler(db) {
  delete require.cache[FN];
  delete require.cache[SUPA];
  require.cache[SUPA] = { id: SUPA, filename: SUPA, loaded: true, exports: { createClient: () => stubSupabase(db) } };
  process.env.SUPABASE_URL = 'https://stub.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'stub';
  return require(FN).handler;
}

const call = (handler, slug) =>
  handler({ httpMethod: 'GET', queryStringParameters: { slug } }).then(r => JSON.parse(r.body));

const PAPERBACK = { slug: 'a-book', title: 'A Book', format: null, price_inr: 199, original_price_inr: 499, is_active: true };
const HARDCOVER = { slug: 'a-book-hc', title: 'A Book', format: 'Hardcover', price_inr: 699, original_price_inr: 999, is_active: true };
const EBOOK = { slug: 'a-book', title: 'A Book', price: 149, mrp: 399, pages: 200, size_bytes: 1048576, active: true };

test('a lone print edition is not a choice, so no strip', async () => {
  const out = await call(loadHandler({ custom_products: [PAPERBACK] }), 'a-book');
  assert.deepEqual(out.formats, []);
});

test('print + ebook gives two formats, print current', async () => {
  const out = await call(loadHandler({ custom_products: [PAPERBACK], ebooks: [EBOOK] }), 'a-book');
  assert.equal(out.formats.length, 2);
  assert.equal(out.formats[0].kind, 'print');
  assert.equal(out.formats[0].current, true);
  assert.equal(out.formats[0].label, 'Paperback', 'a blank format falls back to Paperback');
  assert.equal(out.formats[1].kind, 'ebook');
  assert.equal(out.formats[1].price, 149);
  assert.equal(out.formats[1].size_mb, 1);
});

test('a linked hardcover appears, labelled from custom_products.format', async () => {
  const handler = loadHandler({
    custom_products: [PAPERBACK, HARDCOVER],
    product_editions: [{ slug: 'a-book', group_key: 'g1', sort: 0 }, { slug: 'a-book-hc', group_key: 'g1', sort: 1 }],
  });
  const out = await call(handler, 'a-book');
  assert.equal(out.formats.length, 2);
  const hc = out.formats[1];
  assert.equal(hc.kind, 'print');
  assert.equal(hc.label, 'Hardcover');
  assert.equal(hc.current, false);
  assert.equal(hc.url, '/product/a-book-hc/', 'the chip must be a link to its own page');
});

test('a de-listed sibling is dropped, not shown as a dead link', async () => {
  const handler = loadHandler({
    custom_products: [PAPERBACK, { ...HARDCOVER, is_active: false }],
    product_editions: [{ slug: 'a-book', group_key: 'g1', sort: 0 }, { slug: 'a-book-hc', group_key: 'g1', sort: 1 }],
    ebooks: [EBOOK],
  });
  const out = await call(handler, 'a-book');
  assert.deepEqual(out.formats.map(f => f.kind), ['print', 'ebook']);
});

test('the book being viewed is never listed twice', async () => {
  const handler = loadHandler({
    custom_products: [PAPERBACK, HARDCOVER],
    product_editions: [{ slug: 'a-book', group_key: 'g1', sort: 0 }, { slug: 'a-book-hc', group_key: 'g1', sort: 1 }],
  });
  const out = await call(handler, 'a-book');
  assert.equal(out.formats.filter(f => f.slug === 'a-book').length, 1);
});

test('a missing product_editions table reads as no siblings, not an error', async () => {
  const handler = loadHandler({
    custom_products: [PAPERBACK],
    product_editions: new Error('relation "product_editions" does not exist'),
    ebooks: [EBOOK],
  });
  const out = await call(handler, 'a-book');
  assert.deepEqual(out.formats.map(f => f.kind), ['print', 'ebook']);
});

test('an inactive ebook is not offered', async () => {
  const handler = loadHandler({ custom_products: [PAPERBACK], ebooks: [] });
  const out = await call(handler, 'a-book');
  assert.deepEqual(out.formats, []);
});

test('no slug asks nothing of the database', async () => {
  const out = await call(loadHandler({}), '');
  assert.deepEqual(out.formats, []);
});
