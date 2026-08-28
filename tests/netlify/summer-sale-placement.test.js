const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const campaign = fs.readFileSync(path.join(root, 'public/js/summer-sale.js'), 'utf8');
const productPage = fs.readFileSync(path.join(root, 'netlify/functions/product-page.js'), 'utf8');

test('dynamic product pages expose a stable price-row anchor', () => {
  assert.match(productPage, /class="product-price-row" data-sale-anchor/);
  // The attribute must carry a NUMBER, not the display string — the savings
  // badge and the Google-discount script both read a price out of it. The value
  // moved into `saleNum` when the badge was added; assert the derivation too, so
  // this still fails if the attribute ever goes back to being empty.
  assert.match(productPage, /data-product-price="\$\{saleNum\}"/);
  assert.match(productPage, /const saleNum = Number\(product\.price_inr\) \|\| 0;/);
});

test('campaign fallback never inserts into the cover gallery', () => {
  assert.match(campaign, /main section:not\(\.cover\)/);
  assert.doesNotMatch(campaign, /document\.querySelector\('main section'\)/);
});

test('does not duplicate campaign markup already rendered by generated pages', () => {
  assert.match(campaign, /document\.getElementById\('prodSaleBox'\) \|\| document\.querySelector\('\.prod-sale-box'\)/);
});
