'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAmazonInput, isbn10From13 } = require('./amazon-listing');

test('a full Amazon.in product link, tracking and all, gives the ASIN', () => {
  const url = 'https://www.amazon.in/Strange-Pictures-Uketsu/dp/1805335391/ref=zg_bs_g_1318161031_d_sccl_18/522-7221478-6360508?psc=1';
  assert.deepEqual(parseAmazonInput(url), { asin: '1805335391' });
  assert.deepEqual(parseAmazonInput('amazon.in/gp/product/0143442295?th=1'), { asin: '0143442295' });
  assert.deepEqual(parseAmazonInput('https://www.amazon.in/dp/B0ABCDEFGH'), { asin: 'B0ABCDEFGH' });
});

test('a bare ASIN or an ISBN works too', () => {
  assert.deepEqual(parseAmazonInput(' 1805335391 '), { asin: '1805335391' });
  assert.equal(isbn10From13('978-0-14-344229-5'), '0143442295');
  assert.deepEqual(parseAmazonInput('9780143442295'), { asin: '0143442295' });
  assert.match(parseAmazonInput('9791234567896').error, /no ISBN-10/);
});

test('short links are followed later; other sites and pageless links are refused', () => {
  assert.deepEqual(parseAmazonInput('https://amzn.in/d/abc123?x=1'), { shortUrl: 'https://amzn.in/d/abc123' });
  assert.match(parseAmazonInput('https://evil.example/dp/1805335391').error, /amazon\.in/);
  assert.match(parseAmazonInput('https://www.amazon.in/s?k=uketsu').error, /\/dp\//);
  assert.match(parseAmazonInput('').error, /Paste/);
});

// ── the endpoint ────────────────────────────────────────────────────────────

const PAD = ' '.repeat(25000);
const page = `<html>${PAD}<span id="productTitle">  Strange Pictures (Paperback)  </span>
  <div id="bylineInfo">by <span class="author notFaded"><a href="/x">Uketsu</a> <span class="contribution"><span>(Author)</span> </span></span>
    <span class="author notFaded"><a href="/y">Jim Rion</a> <span class="contribution"><span>(Translator)</span> </span></span>
    <span class="a-color-secondary">Format: </span><span>Paperback</span></div>
  <div id="corePriceDisplay_desktop_feature_div"><span class="priceToPay"><span class="a-offscreen">₹399.00</span></span>
    <span class="basisPrice">M.R.P.: <span class="a-offscreen">₹699.00</span></span></div>
  <div id="wayfinding-breadcrumbs_feature_div"><ul><li><a href="/b">Books</a></li><li><a href="/c">Crime, Thriller &amp; Mystery</a></li></ul></div>
  <div id="detailBullets_feature_div"><ul>
    <li><span class="a-list-item"><span class="a-text-bold">Publisher &rlm; : &lrm;</span> <span>Pushkin Vertigo (1 May 2025)</span></span></li>
    <li><span class="a-list-item"><span class="a-text-bold">Language &rlm; : &lrm;</span> <span>English</span></span></li>
    <li><span class="a-list-item"><span class="a-text-bold">Print length &rlm; : &lrm;</span> <span>240 pages</span></span></li>
    <li><span class="a-list-item"><span class="a-text-bold">ISBN-13 &rlm; : &lrm;</span> <span>978-1805335399</span></span></li>
    <li><span class="a-list-item"><span class="a-text-bold">Item Weight &rlm; : &lrm;</span> <span>250 g</span></span></li>
  </ul></div>
  <div id="bookDescription_feature_div"><div class="a-expander-content">A drawing left by a dying woman.</div></div>
  <img src="https://m.media-amazon.com/images/I/cover.jpg"></html>`;

function fakeFetch(calls) {
  return async (url, opts = {}) => {
    calls.push(url);
    const ok = (body, type = 'text/html') => ({ status: 200, ok: true, headers: new Map([['content-type', type]]), text: async () => body, json: async () => JSON.parse(body) });
    if (url.startsWith('https://amzn.in/')) return { status: 301, headers: new Map([['location', 'https://www.amazon.in/dp/1805335391?ref=x']]) };
    if (url.startsWith('https://www.amazon.in/dp/1805335391')) return ok(page);
    if (url.startsWith('https://www.crossword.in/')) return ok('{"resources":{"results":{"products":[]}}}', 'application/json');
    if (url.startsWith('https://api.openai.com/')) {
      assert.match(JSON.parse(opts.body).messages[1].content, /facts only/);
      return ok(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ description: 'Fresh copy.', author_bio: '', tags: 'uketsu, japanese horror', seo_title: 'Strange Pictures by Uketsu | Paperback', meta_description: 'm' }) } }] }), 'application/json');
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

const { handler } = require('../admin-amazon-listing');
const call = (url, deps) => handler(
  { httpMethod: 'POST', headers: { 'x-admin-key': process.env.ADMIN_SECRET }, body: JSON.stringify({ url }) },
  {}, deps,
);

test('an Amazon link fills every field but the cover, priced at M.R.P. − 40%', async () => {
  process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-admin-secret-0123456789';
  process.env.OPENAI_API_KEY = 'sk-test';
  const calls = [];
  const res = await call('https://amzn.in/d/abc123', {
    fetchImpl: fakeFetch(calls), db: {},
    loadCatalogue: async () => [{ title: 'Strange Houses by Uketsu', slug: 'strange-houses', source: 'custom' }],
  });
  const out = JSON.parse(res.body);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(out.asin, '1805335391');
  const f = out.fields;
  assert.equal(f.title, 'Strange Pictures by Uketsu');
  assert.equal(f.author, 'Uketsu');
  assert.equal(f.isbn, '9781805335399');
  assert.equal(f.original_price_inr, 699);
  assert.equal(f.price_inr, 419);
  assert.equal(f.category, 'Fiction');
  assert.equal(f.publisher, 'Pushkin Vertigo');
  assert.equal(f.pages, 240);
  assert.equal(f.weight_grams, 250);
  assert.equal(f.description, 'Fresh copy.');
  assert.equal(out.duplicate, null, 'a different book by the same author is not a duplicate');
  assert.ok(!('image_url' in f) && !/media-amazon/.test(res.body), 'no Amazon image anywhere');
  assert.ok(!/dying woman/.test(res.body), 'Amazon blurb is never returned');
  delete process.env.OPENAI_API_KEY;
});

test('a book we already list is flagged', async () => {
  const res = await call('https://www.amazon.in/dp/1805335391', {
    fetchImpl: fakeFetch([]), db: {},
    loadCatalogue: async () => [{ title: 'Strange Pictures by Uketsu', slug: 'strange-pictures', source: 'custom', isbn: '9781805335399' }],
  });
  const out = JSON.parse(res.body);
  assert.equal(out.duplicate.kind, 'exact');
  assert.equal(out.duplicate.slug, 'strange-pictures');
  assert.ok(out.warnings.some((w) => /OPENAI_API_KEY/.test(w)));
});

test('non-admins get nothing', async () => {
  const res = await handler({ httpMethod: 'POST', headers: {}, body: '{"url":"1805335391"}' }, {}, { fetchImpl: () => { throw new Error('fetched'); } });
  assert.equal(res.statusCode, 401);
});
