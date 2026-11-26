const test = require('node:test');
const assert = require('node:assert');
const scout = require('./title-scout');
const agent = require('./bestseller-agent');
const { _test: job } = require('../title-scout-scheduled');

const result = ({ asin, title, author, format = 'Paperback', sponsored = false }) => `
<div data-asin="${asin}" data-index="1" data-component-type="s-search-result" class="s-result-item">
  ${sponsored ? '<span class="puis-sponsored-label-text">Sponsored</span>' : ''}
  <h2 aria-label="${title}" class="a-size-medium"><span>${title}</span></h2>
  <div class="a-row a-size-base a-color-secondary"><div class="a-row"><span class="a-size-base">by </span><a href="/x/e/1">${author}</a> <span> | </span><span>6 May 2022</span></div></div>
  <a class="a-link-normal" href="/dp/${asin}/ref=sr_1_1">${format}</a>
</div>`;

const PAGE = [
  result({ asin: 'B0SPONSOR1', title: 'Fluent Python Sponsored Copy', author: 'Luciano Ramalho', sponsored: true }),
  result({ asin: 'B0KINDLE01', title: 'Fluent Python: Clear, Concise, and Effective Programming', author: 'Luciano Ramalho', format: 'Kindle Edition' }),
  result({ asin: '9198630873', title: 'Python Programming: Fluent In Python', author: 'Hacking Studios' }),
  result({ asin: '9355420838', title: 'Fluent Python: Clear, Concise, and Effective Programming, Second Edition (Grayscale Indian Edition)', author: 'Luciano Ramalho' }),
].join('\n');

test('search page: organic print result whose title and author match wins', () => {
  const rows = scout.parseSearchPage(PAGE);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].sponsored, true);
  assert.equal(rows[1].format, 'Kindle Edition');
  assert.equal(rows[3].author, 'Luciano Ramalho');
  assert.equal(scout.pickSearchHit(rows, { title: 'Fluent python', author: 'Luciano Ramalho' }).asin, '9355420838');
  assert.equal(scout.pickSearchHit(rows, { title: 'Fluent python', author: 'Someone Else' }), null, 'wrong author: no guess');
  assert.equal(scout.pickSearchHit(rows, { title: 'Verity', author: '' }), null, 'short title needs an author');
});

test('requested lines: "by" splits author, titles with | and + stay whole, numbering dropped', () => {
  assert.deepEqual(scout.parseTitleAuthor("Can't Hurt Me (Hindi) by David Goggins"), { title: "Can't Hurt Me (Hindi)", author: 'David Goggins' });
  assert.deepEqual(scout.splitBooks('System Design Interview Vol 1 + Vol 2 by Alex Xu | An Insider Guide\n2. Ikigai by Hector Garcia; Verity'), [
    { title: 'System Design Interview Vol 1 + Vol 2', author: 'Alex Xu' },
    { title: 'Ikigai', author: 'Hector Garcia' },
    { title: 'Verity', author: '' },
  ]);
});

function fakeDb(tables) {
  return {
    from: (t) => {
      const q = { select: () => q, in: () => q, gte: () => q, limit: async () => ({ data: tables[t] || [], error: null }) };
      return q;
    },
  };
}

test('demand: one customer counted once per book across website and WhatsApp', async () => {
  const db = fakeDb({
    site_book_requests: [
      { title: 'Belonging ... By Sonia Gandhi', author: '', contact_key: 'a', request_count: 2, created_at: '2026-11-20T00:00:00Z' },
      { title: 'Fluent Python', author: 'Ramalho', contact_key: 'b', request_count: 1, created_at: '2026-11-21T00:00:00Z' },
    ],
    bot_order_requests: [
      { books: 'Belonging by Sonia Gandhi', customer_phone: '91900', created_at: '2026-11-22T00:00:00Z' },
      { books: 'Belonging by Sonia Gandhi\nIkigai', customer_phone: '91900', created_at: '2026-11-23T00:00:00Z' },
    ],
  });
  const d = await scout.requestDemand(db, { now: Date.parse('2026-11-26T00:00:00Z') });
  const belonging = d.find((x) => x.key === 'belonging');
  assert.equal(belonging.customers, 2, 'website a + WhatsApp 91900 (twice) = 2 customers');
  assert.equal(belonging.requests, 4);
  assert.deepEqual(belonging.sources.sort(), ['website', 'whatsapp']);
  assert.equal(d[0].key, 'belonging', 'most-asked first');
});

test('already listed: every request word in an active listing; switched-off listings are told, not drafted', () => {
  const index = agent.buildCatalogueIndex([
    { title: 'System Design Interview Vol 1 + Vol 2 – High-Level System Design', slug: 'sdi', source: 'custom' },
    { title: 'Belonging: A Journey of Love by Sonia Gandhi', author: 'Sonia Gandhi', slug: 'bel', source: 'custom', inactive: true, weak: true },
    { title: 'Atomic Habits (Preloved)', slug: 'ah-pre', source: 'custom', weak: true },
  ]);
  assert.equal(scout.listedAs(index, { title: 'System Design Interview', author: '' }).state, 'listed');
  assert.equal(scout.listedAs(index, { title: 'Belonging', author: 'Sonia Gandhi' }).state, 'switched_off');
  assert.equal(scout.listedAs(index, { title: 'Atomic Habits', author: '' }), null, 'a preloved copy does not stop a new one');
  assert.equal(scout.listedAs(index, { title: 'Fluent Python', author: '' }), null);
});

test('findSeeds: searches unlisted requests, remembers them, stops when Amazon pushes back', async () => {
  const mem = {};
  const store = { get: async (k) => mem[k] || null, setJSON: async (k, v) => { mem[k] = v; } };
  const pages = [];
  const fetchImpl = async (url) => {
    pages.push(url);
    if (/Without/.test(decodeURIComponent(url))) return { status: 503, text: async () => '' };
    return { status: 200, text: async () => PAGE };
  };
  const demand = [
    { key: 'fluent python', title: 'Fluent Python', author: 'Luciano Ramalho', customers: 2, requests: 3, sources: ['website'] },
    { key: 'without fear favour', title: 'Without Fear or Favour', author: '', customers: 1, requests: 1, sources: ['whatsapp'] },
    { key: 'never reached', title: 'Never Reached', author: '', customers: 1, requests: 1, sources: ['whatsapp'] },
  ];
  const out = await scout.findSeeds({ catalogue: [], demand, units: new Map(), store, fetchImpl, now: Date.parse('2026-11-26T00:00:00Z'), pauseMs: 0 });
  assert.equal(out.seeds.length, 1);
  assert.equal(out.seeds[0].asin, '9355420838');
  assert.equal(out.seeds[0].source, 'customer_request');
  assert.equal(out.seeds[0].demand.customers, 2);
  assert.equal(pages.length, 2, 'stopped after the 503');
  assert.ok(mem[scout.STATE_KEY].requests['fluent python'], 'searched request remembered');
  assert.equal(mem[scout.STATE_KEY].requests['without fear favour'], undefined, 'failed search is retried tomorrow');

  pages.length = 0;
  const again = await scout.findSeeds({ catalogue: [], demand: demand.slice(0, 1), units: new Map(), store, fetchImpl, now: Date.parse('2026-11-27T00:00:00Z'), pauseMs: 0 });
  assert.equal(pages.length, 0, 'not searched again within 14 days');
  assert.equal(again.seeds.length, 0);
});

test('score: customer demand outranks the market; unready drafts sink', () => {
  const units = new Map([['colleen hoover', 40]]);
  const bestseller = { source: 'amazon_bestseller', best_rank: 1, lists: [1, 2], times_seen: 31, image_url: 'x', mrp_inr: 499, price_inr: 299 };
  const asked = { source: 'customer_request', demand: { customers: 3, sources: ['whatsapp'] }, image_url: 'x', mrp_inr: 499, price_inr: 299 };
  const b = scout.scoreCandidate(bestseller);
  const a = scout.scoreCandidate(asked);
  assert.equal(b.score, 30 + 2 + 10);
  assert.equal(a.score, 45);
  assert.ok(a.score > b.score);
  assert.match(a.reasons[0], /3 customers asked/);
  const hoover = scout.scoreCandidate({ ...bestseller, author: 'Colleen Hoover' }, { units });
  assert.ok(hoover.score > b.score && hoover.reasons.some((r) => /sold 40 here/.test(r)));
  const bare = scout.scoreCandidate({ ...bestseller, image_url: null, mrp_inr: null, possible_duplicate: { title: 'x' } });
  assert.equal(bare.score, 42 - 10 - 15 - 12);
  assert.equal(scout.isReady(bestseller), true);
  assert.equal(scout.isReady({ ...bestseller, possible_duplicate: { title: 'x' } }), false);
});

test('author units: lifetime sales by first author, from listings and ranked cards', () => {
  const doc = { counts: { 'verity-ch': 30, 'it-ends-ch': 12, 'misc': 9 }, bsr: { info: { 'it-ends-ch': { author: 'Colleen Hoover' } } } };
  const units = scout.authorUnits(doc, [{ slug: 'verity-ch', author: 'Colleen Hoover, Someone' }, { slug: 'misc', author: 'Various' }]);
  assert.equal(units.get('colleen hoover'), 42);
  assert.equal(units.has('various'), false);
});

test('rescore: a draft listed since it was made leaves the queue; near matches are flagged', async () => {
  const rows = [
    { id: 'a', status: 'pending', title: 'The Law of the Sublime by Robert Greene', author: 'Robert Greene', score: null, image_url: 'x', mrp_inr: 1, price_inr: 1 },
    { id: 'b', status: 'pending', title: 'Hidden Pictures by Jason Rekulak', author: 'Jason Rekulak', score: null, best_rank: 7, source: 'amazon_bestseller', image_url: 'x', mrp_inr: 1, price_inr: 1 },
  ];
  const batches = [];
  const db = {
    from: () => {
      const q = {
        select: () => q, eq: () => q, order: () => q,
        range: async () => ({ data: rows, error: null }),
        upsert: async (list) => { batches.push(list); return { error: null }; },
      };
      return q;
    },
  };
  const out = await scout.rescorePending(db, { catalogue: [{ title: 'The Law of the Sublime', slug: 'law', source: 'custom', author: 'Robert Greene' }] });
  assert.equal(out.now_listed, 1);
  assert.equal(batches.length, 2, 'one batch per patch shape');
  for (const b of batches) {
    const shapes = new Set(b.map((r) => Object.keys(r).sort().join(',')));
    assert.equal(shapes.size, 1, 'never a mixed batch (missing keys would be written as NULL)');
  }
  const all = batches.flat();
  assert.equal(all.find((r) => r.id === 'a').status, 'in_catalogue');
  assert.ok(all.find((r) => r.id === 'b').score > 0, 'the other is scored');
  assert.equal(out.changed, 2);
  assert.equal(out.pending, 1);
});

test('digest: one email a day, lists switched-off books customers asked for', async () => {
  const mem = {};
  const store = { get: async (k) => mem[k] || null, setJSON: async (k, v) => { mem[k] = v; } };
  const sent = [];
  const prev = process.env.STORE_OWNER_EMAIL;
  process.env.STORE_OWNER_EMAIL = 'owner@example.com';
  try {
    const args = {
      store, now: Date.parse('2026-11-25T21:40:00Z'),
      summary: { drafted: 4 },
      rescore: { pending: 12, top: [{ title: 'Fluent Python by Luciano Ramalho', score: 55, source: 'customer_request', score_reasons: ['2 customers asked'], price_inr: 1500, mrp_inr: 2500, image_url: 'x' }] },
      switchedOff: [{ listing: 'Belonging: A Journey of Love', customers: 21 }],
      sendEmail: async (m) => { sent.push(m); return { ok: true }; },
    };
    assert.equal(await job.sendDigest(args), 'sent');
    assert.equal(await job.sendDigest(args), 'already sent today');
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /4 new books drafted · 12 waiting/);
    assert.match(sent[0].html, /Belonging: A Journey of Love — 21 customers asked/);
    assert.match(sent[0].html, /Customers asked/);
  } finally {
    if (prev === undefined) delete process.env.STORE_OWNER_EMAIL; else process.env.STORE_OWNER_EMAIL = prev;
  }
});
