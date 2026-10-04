'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const agent = require('./bestseller-agent');

// ── fixtures shaped like the live Amazon.in markup (30 Sep 2026) ────────────

function listPage(items, recs) {
  const recsAttr = recs
    ? ` data-client-recs-list="${JSON.stringify(recs.map(([id, rank]) => ({ id, metadataMap: { 'render.zg.rank': String(rank) } }))).replace(/"/g, '&quot;')}"`
    : '';
  const grid = items.map(([asin, rank, title, author, price]) => `<div id="gridItemRoot" class="x"><span>#${rank}</span>
    <a href="/${encodeURIComponent(title)}/dp/${asin}/ref=zg"><div class="_cDEzb_p13n-sc-css-line-clamp-1_1Fn1y">${title}</div></a>
    <div class="a-row"><a class="a-size-small a-link-child" href="/e/x">${author}</a></div>
    <span class="_cDEzb_p13n-sc-price_3mJ9Z">₹${price}.00</span></div>`).join('');
  return `<html><div class="p13n-gridRow"${recsAttr}>${grid}</div></html>`;
}

const PAD = ' '.repeat(25000);
function productPage({ title = 'Some Book: A Subtitle | Marketing Words', authors = [['Jane Doe', 'Author']], format = 'Paperback',
  isbn13 = '978-0143442295', mrp = '299.00', price = '178.00', lang = 'English', extraMrp = true } = {}) {
  const byline = authors.map(([n, r]) => `<span class="author notFaded" data-width=""><a class="a-link-normal" href="/x">${n}</a> <span class="contribution" spacing="none"><span class="a-color-secondary">(${r})</span> </span></span>`).join(' ');
  const bullet = (k, v) => `<li><span class="a-list-item"><span class="a-text-bold">${k}\n &rlm;\n :\n &lrm;\n </span> <span>${v}</span></span></li>`;
  return `<html>${PAD}<span id="productTitle" class="a-size-large">  ${title}  </span>
    <div id="bylineInfo" class="a-section">by ${byline} <span class="a-color-secondary">Format: </span><span>${format}</span></div>
    <div id="corePriceDisplay_desktop_feature_div"><span class="priceToPay"><span class="a-offscreen">₹${price}</span><span class="a-price-whole">${price.split('.')[0]}</span></span>
      ${mrp ? `<span class="basisPrice">M.R.P.: <span class="a-price a-text-price"><span class="a-offscreen">₹${mrp}</span></span></span>` : ''}</div>
    ${extraMrp ? '<div class="also-bought">M.R.P: ₹1,499.00</div>' : ''}
    <div id="detailBullets_feature_div"><ul class="a-unordered-list">
      ${bullet('Publisher', 'Penguin Ananda; 1st edition (17 September 2018)')}
      ${bullet('Publication date', '17 September 2018')}
      ${bullet('Language', lang)}
      ${bullet('Print length', '256 pages')}
      ${isbn13 ? bullet('ISBN-13', isbn13) : ''}
      ${bullet('Reading age', 'Customer suggested age: 15 years and up')}
      ${bullet('Item Weight', '170 g')}
      ${bullet('Dimensions', '19.8 x 12.9 x 1.42 cm')}
    </ul></div>
    <div id="bookDescription_feature_div"><div class="a-expander-content">Stop going through life, start growing through life.</div></div>
  </html>`;
}

// ── parsing ────────────────────────────────────────────────────────────────

test('list page: rendered titles plus the unrendered ranks from data-client-recs-list', () => {
  const html = listPage(
    [['0143442295', 1, 'Life&#39;s Amazing Secrets', 'Gaur Gopal Das', 178]],
    [['0143442295', 1], ['B0ABCDEFGH', 2], ['9357292365', 31]],
  );
  const out = agent.parseListPage(html);
  assert.deepEqual(out.map((e) => [e.asin, e.rank]), [['0143442295', 1], ['B0ABCDEFGH', 2], ['9357292365', 31]]);
  assert.equal(out[0].title, "Life's Amazing Secrets");
  assert.equal(out[0].author, 'Gaur Gopal Das');
  assert.equal(out[0].price, 178);
  assert.equal(out[1].title, undefined);
});

test('product page: details, authors, format, and the buy-box M.R.P. rather than another book\'s', () => {
  const p = agent.parseProductPage(productPage({ authors: [['Gaur Gopal Das', 'Author'], ['Someone', 'Illustrator']] }), '0143442295');
  assert.equal(p.ok, true);
  assert.equal(p.isbn13, '9780143442295');
  assert.equal(p.author, 'Gaur Gopal Das');
  assert.equal(p.format, 'Paperback');
  assert.equal(p.publisher, 'Penguin Ananda');
  assert.equal(p.language, 'English');
  assert.equal(p.pages, 256);
  assert.equal(p.weight_grams, 170);
  assert.equal(p.reading_age, '15 years and up');
  assert.equal(p.mrp, 299);
  assert.equal(p.price, 178);
  assert.match(p.blurb, /growing through life/);
});

test('product page: Kindle editions, missing ISBNs and bot walls are not drafted', () => {
  assert.equal(agent.parseProductPage(productPage({ format: 'Kindle Edition', isbn13: '' }), 'B0ABCDEFGH').reason, 'kindle edition');
  assert.equal(agent.parseProductPage(productPage({ isbn13: '' }), 'B0ABCDEFGH').ok, false);
  assert.equal(agent.parseProductPage('<html>Type the characters you see in this image</html>', 'x').reason, 'blocked');
});

test('product page: an ISBN-10 ASIN supplies the ISBN when the details list lacks one', () => {
  const p = agent.parseProductPage(productPage({ isbn13: '' }), '0143442295');
  assert.equal(p.ok, true);
  assert.equal(p.isbn13, '9780143442295');
});

// ── titles and matching ────────────────────────────────────────────────────

test('coreTitle: Amazon and catalogue spellings of one book agree', () => {
  assert.equal(agent.coreTitle("Life's Amazing Secrets: How to Find Balance | Inspirational Zen book"), 'lifes amazing secrets');
  assert.equal(agent.coreTitle("Life's Amazing Secrets by Gaur Gopal Das"), 'lifes amazing secrets');
  assert.equal(agent.coreTitle('Atomic Habits (Paperback)'), 'atomic habits');
});

test('listingTitle: drops Amazon marketing, adds the author the catalogue way', () => {
  assert.equal(agent.listingTitle("Life's Amazing Secrets: How to Find Balance | Inspirational Zen book", 'Gaur Gopal Das, X'),
    "Life's Amazing Secrets: How to Find Balance by Gaur Gopal Das");
  assert.equal(agent.listingTitle('Atomic Habits by James Clear (Paperback)', 'James Clear'), 'Atomic Habits by James Clear');
  assert.equal(agent.listingTitle('TUESDAYS WITH MORRIE (EXPORT) (A FORMAT)', 'Mitch Albom'), 'Tuesdays With Morrie by Mitch Albom');
});

test('author names keep their accents', () => {
  const p = agent.parseProductPage(productPage({ authors: [['Antoine de Saint-Exup&eacute;ry', 'Author']] }), '0143442295');
  assert.equal(p.author, 'Antoine de Saint-Exupéry');
});

test('categoryFor: the book\'s own Amazon category beats the list it was found on', () => {
  const comics = agent.LISTS.find((l) => /comics/i.test(l.name));
  assert.equal(agent.categoryFor(comics, ['Books', "Children's Books", 'Literature']), 'Kids Book');
  assert.equal(agent.categoryFor(comics, ['Books', 'Comics & Mangas', 'Manga']), 'Manga');
  assert.equal(agent.categoryFor(comics, ['Books', 'Comics & Mangas', 'Superheroes']), 'Comics');
  assert.equal(agent.categoryFor(comics, []), comics.category);
});

test('matchCatalogue: exact, short titles need the author, preloved is only near', () => {
  const index = agent.buildCatalogueIndex([
    { title: "Life's Amazing Secrets by Gaur Gopal Das", slug: 'las', source: 'catalogue' },
    { title: 'Verity by Colleen Hoover', slug: 'verity', source: 'catalogue' },
    { title: 'Ikigai by Hector Garcia (Preloved)', slug: 'ikigai-preloved', source: 'catalogue', weak: true },
    { title: 'The Psychology of Money by Morgan Housel', slug: 'pom', source: 'catalogue' },
    { title: 'Custom Book', slug: 'cb', source: 'custom', isbn: '9780143442295' },
  ]);
  assert.equal(agent.matchCatalogue(index, { title: "Life's Amazing Secrets: How to find balance", author: 'Gaur Gopal Das' }).kind, 'exact');
  assert.equal(agent.matchCatalogue(index, { title: 'Verity', author: 'Colleen Hoover' }).kind, 'exact');
  assert.equal(agent.matchCatalogue(index, { title: 'Verity', author: 'Someone Else' }).kind, 'near');
  assert.equal(agent.matchCatalogue(index, { title: 'Ikigai', author: 'Hector Garcia' }).kind, 'near');
  assert.equal(agent.matchCatalogue(index, { title: 'Psychology of Money Deluxe Edition', author: 'Morgan Housel' }).kind, 'exact');
  assert.equal(agent.matchCatalogue(index, { title: 'Anything', isbn13: '9780143442295' }).kind, 'exact');
  assert.equal(agent.matchCatalogue(index, { title: 'The Midnight Library', author: 'Matt Haig' }).kind, null);
});

// ── money ──────────────────────────────────────────────────────────────────

test('price is M.R.P. minus 40%, rounded to the rupee', () => {
  assert.equal(agent.priceFromMrp(299), 179);
  assert.equal(agent.priceFromMrp(499), 299);
  assert.equal(agent.priceFromMrp(0), null);
  assert.equal(agent.priceFromMrp(null), null);
});

test('decideMrp: Amazon first, Crossword next, selling price only as a flagged guess', () => {
  assert.deepEqual(agent.decideMrp({ amazonMrp: 299, crosswordMrp: 299 }), { mrp: 299, source: 'amazon', warnings: [] });
  const differ = agent.decideMrp({ amazonMrp: 299, crosswordMrp: 350 });
  assert.equal(differ.mrp, 299);
  assert.match(differ.warnings[0], /differs/);
  assert.equal(agent.decideMrp({ crosswordMrp: 350, amazonPrice: 300 }).source, 'crossword');
  const guess = agent.decideMrp({ amazonPrice: 300 });
  assert.equal(guess.source, 'amazon-price');
  assert.match(guess.warnings[0], /No M\.R\.P\. shown/);
  assert.equal(agent.decideMrp({}).mrp, null);
});

// ── the run, against stubbed network and database ───────────────────────────

function fakeSupabase(initial = []) {
  const rows = new Map(initial.map((r) => [r.asin, { ...r }]));
  const writes = [];
  function builder(table) {
    const q = { table, filters: [], op: 'select', payload: null };
    const run = () => {
      if (table !== 'bestseller_candidates') return { data: [], error: null };
      if (q.op === 'insert') { writes.push(['insert', q.payload]); rows.set(q.payload.asin, { id: `id-${q.payload.asin}`, ...q.payload }); return { data: null, error: null }; }
      if (q.op === 'upsert') { writes.push(['upsert', q.payload]); rows.set(q.payload.asin, { ...(rows.get(q.payload.asin) || {}), ...q.payload }); return { data: null, error: null }; }
      if (q.op === 'update') { writes.push(['update', q.payload]); return { data: null, error: null }; }
      let out = [...rows.values()];
      for (const [col, kind, val] of q.filters) out = out.filter((r) => (kind === 'in' ? val.includes(r[col]) : r[col] === val));
      return { data: out, error: null };
    };
    const api = {
      select() { return api; },
      in(col, vals) { q.filters.push([col, 'in', vals]); return api; },
      eq(col, val) { q.filters.push([col, 'eq', val]); return api; },
      limit() { return api; },
      insert(p) { q.op = 'insert'; q.payload = p; return api; },
      upsert(p) { q.op = 'upsert'; q.payload = p; return api; },
      update(p) { q.op = 'update'; q.payload = p; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }
  return { from: builder, rows, writes };
}

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    for (const [pattern, reply] of routes) {
      if (pattern.test(url)) {
        const r = typeof reply === 'function' ? reply(url) : reply;
        return {
          ok: (r.status || 200) < 400, status: r.status || 200,
          headers: { get: () => null },
          text: async () => r.body || '',
          json: async () => JSON.parse(r.body || '{}'),
        };
      }
    }
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => '', json: async () => ({}) };
  };
  impl.calls = calls;
  return impl;
}

const ONE_LIST = [agent.LISTS[0].id];

test('run: skips known and already-listed titles, drafts the new one at M.R.P. − 40%', async () => {
  const list = listPage(
    [['0143442295', 1, "Life's Amazing Secrets", 'Gaur Gopal Das', 178], ['9352776308', 2, 'The New One', 'New Author', 250]],
    [['0143442295', 1], ['9352776308', 2], ['B0KNOWNXXX', 3]],
  );
  const fetchImpl = fakeFetch([
    [/bestsellers/, { body: list }],
    [/\/dp\/9352776308/, { body: productPage({ title: 'The New One: A Novel | Bestseller', authors: [['New Author', 'Author']], isbn13: '978-9352776306', mrp: '499.00', price: '350.00' }) }],
    [/crossword/, { body: JSON.stringify({ resources: { results: { products: [] } } }) }],
    [/openlibrary/, { status: 404 }],
    [/googleapis/, { body: JSON.stringify({ items: [{ volumeInfo: { imageLinks: { thumbnail: 'http://books.google.com/x?id=1&zoom=1&edge=curl' } } }] }) }],
  ]);
  const supabase = fakeSupabase([{ id: 'k1', asin: 'B0KNOWNXXX', status: 'rejected' }]);
  const summary = await agent.runAgent({
    supabase, fetchImpl, pauseMs: 0,
    catalogue: [{ title: "Life's Amazing Secrets by Gaur Gopal Das", slug: 'las', source: 'catalogue' }],
  }, { limit: 5, lists: ONE_LIST });

  assert.equal(summary.already_known, 1);
  assert.equal(summary.in_catalogue, 1);
  assert.equal(summary.drafted, 1);
  assert.equal(summary.failed, 0, summary.errors.join('; '));
  assert.ok(!fetchImpl.calls.some((u) => /\/dp\/0143442295/.test(u)), 'an already-listed title costs no product-page fetch');

  const draft = supabase.rows.get('9352776308');
  assert.equal(draft.status, 'pending');
  assert.equal(draft.title, 'The New One: A Novel by New Author');
  assert.equal(draft.mrp_inr, 499);
  assert.equal(draft.price_inr, 299);
  assert.equal(draft.isbn13, '9789352776306');
  assert.equal(draft.image_source, 'googlebooks');
  assert.equal(draft.image_url, 'https://books.google.com/x?id=1&zoom=2');
  assert.equal(draft.category, agent.LISTS[0].category);
  assert.ok(!/amazon/i.test(draft.image_url));
  assert.equal(supabase.rows.get('0143442295').status, 'in_catalogue');
});

test('run: a dry run writes nothing', async () => {
  const fetchImpl = fakeFetch([
    [/bestsellers/, { body: listPage([['9352776308', 1, 'The New One', 'New Author', 250]], [['9352776308', 1]]) }],
    [/\/dp\//, { body: productPage({ isbn13: '978-9352776306' }) }],
  ]);
  const supabase = fakeSupabase();
  const summary = await agent.runAgent({ supabase, fetchImpl, pauseMs: 0, catalogue: [] }, { limit: 5, lists: ONE_LIST, dryRun: true });
  assert.equal(summary.drafted, 1);
  assert.equal(supabase.writes.length, 0);
});

test('run: a bot wall stops the run and is not remembered, so the next run retries', async () => {
  const fetchImpl = fakeFetch([
    [/bestsellers/, { body: listPage([], [['9352776308', 1], ['9352776309', 2]]) }],
    [/\/dp\//, { body: '<html>Type the characters you see in this image</html>' }],
  ]);
  const supabase = fakeSupabase();
  const summary = await agent.runAgent({ supabase, fetchImpl, pauseMs: 0, catalogue: [] }, { limit: 5, lists: ONE_LIST });
  assert.equal(summary.failed, 1);
  assert.equal(summary.drafted, 0);
  assert.equal(fetchImpl.calls.filter((u) => /\/dp\//.test(u)).length, 1);
  assert.equal(supabase.writes.length, 0);
});

test('run: honours the limit and reports what is left for the next run', async () => {
  const fetchImpl = fakeFetch([
    [/bestsellers/, { body: listPage([], [['0062316095', 1], ['0143442295', 2], ['0141439513', 3]]) }],
    [/\/dp\//, (url) => ({ body: productPage({ isbn13: '', title: `Book ${url.slice(-10)}` }) })],
  ]);
  const supabase = fakeSupabase();
  const summary = await agent.runAgent({ supabase, fetchImpl, pauseMs: 0, catalogue: [] }, { limit: 2, lists: ONE_LIST });
  assert.equal(summary.drafted, 2);
  assert.equal(summary.remaining, 1);
});

test('genres: every Amazon books list is known, the nightly run reads only the store\'s genres', async () => {
  const ids = agent.LISTS.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, 'no genre listed twice');
  assert.equal(agent.LISTS.length, 36);
  assert.equal(agent.NIGHTLY_LISTS.length, 11);
  for (const name of ['Exam Preparation', 'School Books', 'Textbooks & Study Guides']) {
    assert.ok(!agent.NIGHTLY_LISTS.some((l) => l.name === name), `${name} is on demand only`);
  }

  const fetchImpl = fakeFetch([[/bestsellers/, { body: listPage([], [['0062316095', 1]]) }]]);
  await agent.runAgent({ supabase: fakeSupabase(), fetchImpl, pauseMs: 0, catalogue: [] }, { limit: 0 });
  assert.equal(fetchImpl.calls.length, 11, 'one page per nightly genre');
});

test('genres: one picked genre reads its top 100, and the overall list is /books/', async () => {
  const fetchImpl = fakeFetch([[/bestsellers/, (url) => ({ body: /pg=2/.test(url)
    ? listPage([], [['0141439513', 51]]) : listPage([], [['0062316095', 1]]) })]]);
  const summary = await agent.runAgent({ supabase: fakeSupabase(), fetchImpl, pauseMs: 0, catalogue: [] },
    { limit: 0, lists: ['all'], pages: 2 });
  assert.deepEqual(fetchImpl.calls, ['https://www.amazon.in/gp/bestsellers/books/', 'https://www.amazon.in/gp/bestsellers/books/?pg=2']);
  assert.equal(summary.ranked, 2);
  assert.equal(summary.remaining, 2);
});

test('categoryFor: new genres fall back to a store category', () => {
  const byName = (n) => agent.LISTS.find((l) => l.name === n);
  assert.equal(agent.categoryFor(byName('Health, Fitness & Nutrition'), ['Books', 'Health, Fitness & Nutrition']), 'Health & Fitness');
  assert.equal(agent.categoryFor(byName('Science & Mathematics'), ['Books', 'Science & Mathematics']), 'Science');
  assert.equal(agent.categoryFor(byName('Fantasy, Horror & Science Fiction'), ['Books', 'Fantasy, Horror & Science Fiction']), 'Fiction');
  assert.equal(agent.categoryFor(byName('Travel'), ['Books', 'Travel']), 'Non-Fiction');
});

// ── the endpoint's gate ────────────────────────────────────────────────────

test('scheduled endpoint: an HTTP request without an admin session is refused', async () => {
  process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-admin-secret';
  const { handler } = require('../bestseller-agent-scheduled');
  const res = await handler({ rawUrl: 'https://inkandchai.in/.netlify/functions/bestseller-agent-scheduled', httpMethod: 'POST', headers: { 'x-cloudflare-cron': '0 22 * * *' }, path: '/.netlify/functions/bestseller-agent-scheduled', body: '{}' });
  assert.equal(res.statusCode, 401);
});
