'use strict';

// Create Listing → Fill from Amazon, given a Kindle link.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-admin-secret';
delete process.env.OPENAI_API_KEY;

const { handler } = require('../admin-amazon-listing');

const PAD = ' '.repeat(25000);
const bullet = (k, v) => `<li><span class="a-list-item"><span class="a-text-bold">${k}\n &rlm;\n :\n &lrm;\n </span> <span>${v}</span></span></li>`;

function page({ format, isbn13, mrp, price, swatches = '', pages = '252 pages' }) {
  return `<html>${PAD}<span id="productTitle">The Psychology of Money</span>
    <div id="bylineInfo">by <span class="author notFaded"><a href="/x">Morgan Housel</a> <span class="contribution"><span>(Author)</span></span></span>
      <span class="a-color-secondary">Format: </span><span>${format}</span></div>
    ${swatches}
    <div id="corePriceDisplay_desktop_feature_div"><span class="priceToPay"><span class="a-offscreen">₹${price}</span></span>
      ${mrp ? `<span>M.R.P.: <span class="a-offscreen">₹${mrp}</span></span>` : ''}</div>
    <div id="detailBullets_feature_div"><ul>
      ${bullet('Publisher', 'Jaico Publishing House')}
      ${bullet('Language', 'English')}
      ${bullet('Print length', pages)}
      ${isbn13 ? bullet('ISBN-13', isbn13) : ''}
      ${isbn13 ? bullet('Item Weight', '200 g') : ''}
    </ul></div>
    <div id="bookDescription_feature_div"><div class="a-expander-content">Doing well with money is not about what you know.</div></div>
  </html>`;
}

const swatchesFor = (paperback, hardcover) => `<div id="tmmSwatches">
  <div id="tmm-grid-swatch-KINDLE"><a href="javascript:void(0)">Kindle Edition</a></div>
  ${hardcover ? `<div id="tmm-grid-swatch-HARDCOVER"><a href="/Deluxe/dp/${hardcover}/ref=tmm_hrd_swatch_0">Hardcover</a></div>` : ''}
  ${paperback ? `<div id="tmm-grid-swatch-PAPERBACK"><a href="/Money/dp/${paperback}/ref=tmm_pap_swatch_0">Paperback</a></div>` : ''}
</div>`;

const KINDLE = 'B08FHZ5L47';
const PAPERBACK = 'B0HNQ23RBY';
const HARDCOVER = '9390166934';
const kindlePage = (swatches) => page({ format: 'Kindle Edition', price: '189.05', mrp: '799', swatches });
const printPage = (format, mrp) => page({ format, isbn13: '978-9390166268', mrp, price: '250' });

/** Serves pages by ASIN; records which were asked for. */
function amazon(byAsin) {
  const asked = [];
  const fetchImpl = async (url) => {
    const asin = (String(url).match(/\/dp\/([A-Z0-9]{10})/) || [])[1];
    if (!asin) return new Response('{}', { status: 404 });
    asked.push(asin);
    const html = byAsin[asin];
    return html === undefined ? new Response('gone', { status: 404 }) : new Response(html, { status: 200 });
  };
  return { fetchImpl, asked };
}

async function fill(url, byAsin) {
  const { fetchImpl, asked } = amazon(byAsin);
  const res = await handler(
    { httpMethod: 'POST', headers: { 'x-admin-key': process.env.ADMIN_SECRET }, body: JSON.stringify({ url }) },
    {},
    { fetchImpl, db: {}, loadCatalogue: async () => [] },
  );
  return { status: res.statusCode, body: JSON.parse(res.body), asked };
}

const link = `https://www.amazon.in/Psychology-Money-Morgan-Housel-ebook/dp/${KINDLE}/ref=sr_1_1`;

test('a Kindle link fills the form from the Paperback, priced from its M.R.P.', async () => {
  const { status, body, asked } = await fill(link, {
    [KINDLE]: kindlePage(swatchesFor(PAPERBACK, HARDCOVER)),
    [PAPERBACK]: printPage('Paperback', '399'),
    [HARDCOVER]: printPage('Hardcover', '599'),
  });
  assert.equal(status, 200);
  assert.equal(body.asin, PAPERBACK);
  assert.equal(body.fields.format, 'Paperback');
  assert.equal(body.fields.isbn, '9789390166268');
  assert.equal(body.fields.original_price_inr, 399);
  assert.equal(body.fields.price_inr, 239);
  assert.deepEqual(asked, [KINDLE, PAPERBACK], 'the hardcover is not fetched once the paperback reads');
  assert.match(body.warnings[0], /Kindle edition.*Paperback \(B0HNQ23RBY\)/);
});

test('a Paperback that cannot be read falls through to the Hardcover', async () => {
  const { body } = await fill(link, {
    [KINDLE]: kindlePage(swatchesFor(PAPERBACK, HARDCOVER)),
    [HARDCOVER]: printPage('Hardcover', '599'),
  });
  assert.equal(body.asin, HARDCOVER);
  assert.equal(body.fields.format, 'Hardcover');
  assert.equal(body.fields.original_price_inr, 599);
});

test('with no print edition the facts fill and the price stays blank, never the eBook price', async () => {
  const { status, body } = await fill(link, { [KINDLE]: kindlePage('') });
  assert.equal(status, 200);
  assert.equal(body.asin, KINDLE);
  assert.equal(body.fields.title, 'The Psychology of Money by Morgan Housel');
  assert.equal(body.fields.author, 'Morgan Housel');
  assert.equal(body.fields.publisher, 'Jaico Publishing House');
  assert.equal(body.fields.pages, 252);
  for (const k of ['price_inr', 'original_price_inr', 'isbn', 'format', 'weight_grams']) assert.equal(body.fields[k], '', k);
  assert.match(body.warnings.join(' '), /no print edition/);
  assert.match(body.warnings.join(' '), /No M\.R\.P\. found/);
});

test('print editions that all fail say so, and the eBook price is still not used', async () => {
  const { status, body } = await fill(link, { [KINDLE]: kindlePage(swatchesFor(PAPERBACK, HARDCOVER)) });
  assert.equal(status, 200);
  assert.equal(body.asin, KINDLE);
  assert.equal(body.fields.price_inr, '');
  assert.match(body.warnings.join(' '), /could not be read \(Paperback B0HNQ23RBY: HTTP 404; Hardcover 9390166934: HTTP 404\)/);
});

test('a print link behaves as before: no Kindle note and one fetch of Amazon', async () => {
  const { status, body, asked } = await fill(`https://www.amazon.in/dp/${HARDCOVER}`, { [HARDCOVER]: printPage('Hardcover', '599') });
  assert.equal(status, 200);
  assert.deepEqual(asked, [HARDCOVER]);
  assert.ok(!body.warnings.some((w) => /Kindle/.test(w)));
});

test('a robot check on the link itself is still reported as one', async () => {
  const { status, body } = await fill(link, { [KINDLE]: 'Click the button below to continue shopping' });
  assert.equal(status, 422);
  assert.match(body.error, /robot check/);
});
