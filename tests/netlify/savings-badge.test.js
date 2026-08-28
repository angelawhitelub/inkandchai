const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const productPage = fs.readFileSync(path.join(root, 'netlify/functions/product-page.js'), 'utf8');
const generator = fs.readFileSync(path.join(root, 'generate_site.py'), 'utf8');
const checkout = fs.readFileSync(path.join(root, 'public/checkout/index.html'), 'utf8');
const discount = fs.readFileSync(path.join(root, 'public/js/google-discount.js'), 'utf8');

// The percentage the two page renderers print. Mirrors both implementations —
// if either formula changes, one of the assertions below has to change with it.
function savePct(mrp, sale) {
  return (mrp > sale && sale > 0) ? Math.round((mrp - sale) / mrp * 100) : 0;
}

test('the savings percentage is computed off MRP, not off the sale price', () => {
  assert.equal(savePct(799, 189), 76);
  assert.equal(savePct(98, 49), 50);
  assert.equal(savePct(1199, 69), 94);
});

test('no badge when the MRP is missing, equal, or below the sale price', () => {
  assert.equal(savePct(0, 149), 0);      // no MRP recorded
  assert.equal(savePct(149, 149), 0);    // MRP === sale, would print "0% off"
  assert.equal(savePct(99, 149), 0);     // bad data: MRP under the sale price
  assert.equal(savePct(500, 0), 0);      // no sale price
});

test('both product renderers emit the badge element', () => {
  assert.match(productPage, /data-save-badge/);
  assert.match(productPage, /const savePct = \(mrpNum > saleNum && saleNum > 0\)/);
  assert.match(generator, /data-save-badge/);
  assert.match(generator, /save_pct = int\(round\(\(orig_num - price_num\) \/ orig_num \* 100\)\)/);
});

test('the MRP is exposed as a number so the badge can be recomputed client-side', () => {
  assert.match(productPage, /data-product-original-price="\$\{mrpNum\}"/);
  assert.match(generator, /data-product-original-price="\{orig_num:g\}"/);
});

test('an admin price override rewrites the attribute, not just the visible text', () => {
  // Without this the badge would keep quoting the pre-override discount.
  assert.match(generator, /setAttribute\('data-product-price', String\(Number\(override\.price_inr\) \|\| 0\)\)/);
  assert.match(generator, /setAttribute\('data-product-original-price', String\(Number\(override\.original_price_inr\) \|\| 0\)\)/);
});

test('checkout loads the Google discount script', () => {
  // Every checkout request reads window.iacDiscountGrants(); without the script
  // the grants array is silently empty and the discount is lost at payment time.
  assert.match(checkout, /<script src="\/js\/google-discount\.js"><\/script>/);
  assert.match(checkout, /window\.iacDiscountGrants \? window\.iacDiscountGrants\(\) : \[\]/);
});

test('a Google discount refreshes the savings badge', () => {
  assert.match(discount, /window\.syncSaveBadge/);
});
