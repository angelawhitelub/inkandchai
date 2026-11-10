const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { productId, parseProductId } = require('./product-id');
const { findSoldOut, findShippingRestriction } = require('./shipping-restrictions');
const { autoPushHold } = require('./bot-order-request');

test('IDs are fixed, 10 characters, and ignore case / URL form', () => {
  assert.equal(productId('a-court-of-splintered-harmony-by-sarah-j-maas'), 'ICZRP9V7PG');
  assert.equal(productId('/product/Belonging/'), productId('belonging'));
  assert.equal(productId('https://inkandchai.in/product/belonging/?x=1'), productId('belonging'));
  assert.match(productId('belonging'), /^IC[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.equal(productId(''), '');
  assert.equal(parseProductId(' ic-zrp9 v7pg '), 'ICZRP9V7PG');
  assert.equal(parseProductId('ICZRP9V7P'), '');
  assert.equal(parseProductId('ICZRP9V7PI'), '');   // I is not in the alphabet
});

test('the admin page copy (icProductId) gives the same IDs', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../../public/admin/index.html'), 'utf8');
  const m = html.match(/function icProductId\(slug\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'icProductId not found in the admin page');
  const ctx = { TextEncoder };
  vm.runInNewContext(m[0] + '\nthis.f = icProductId;', ctx);
  for (const s of ['belonging', 'a-court-of-splintered-harmony-by-sarah-j-maas', '/product/Ikigai-123/', 'gunahon-ka-devta']) {
    assert.equal(ctx.f(s), productId(s), s);
  }
});

test('the catalogue has no ID clashes', () => {
  const { getCatalogIndex } = require('./pricing');
  const slugs = Object.keys(getCatalogIndex() || {}).map((s) => s.toLowerCase());
  const ids = new Map();
  for (const s of new Set(slugs)) {
    const id = productId(s);
    assert.ok(!ids.has(id), `${s} and ${ids.get(id)} share ${id}`);
    ids.set(id, s);
  }
});

test('a cart over a book\'s per-order limit is refused on every order path', () => {
  const cart = [
    { slug: 'belonging', title: 'Belonging', qty: 2, _max_qty: 2 },
    { slug: 'belonging', title: 'Belonging', qty: 1, _max_qty: 2 },
  ];
  const r = findSoldOut(cart);
  assert.equal(r.blocked, true);
  assert.equal(r.code, 'product_qty_limit');
  assert.match(r.error, /at most 2 copies of Belonging in one order/);
  assert.equal(findShippingRestriction(cart, { pincode: '110002' }).code, 'product_qty_limit');
  assert.equal(findSoldOut([{ slug: 'belonging', title: 'Belonging', qty: 2, _max_qty: 2 }]).blocked, false);
  assert.equal(findSoldOut([{ slug: 'belonging', title: 'Belonging', qty: 1, _max_qty: 1 }]).blocked, false);
  assert.match(findSoldOut([{ slug: 'x', title: 'X', qty: 2, _max_qty: 1 }]).error, /at most 1 copy of X/);
});

test('a WhatsApp bot order over a limit waits for the owner', () => {
  if (typeof autoPushHold !== 'function') return;
  assert.match(String(autoPushHold({ items: [{ qty: 3, maxQty: 2, matchedTitle: 'Belonging' }], copies: 3 })), /over its limit of 2/);
  assert.equal(autoPushHold({ items: [{ qty: 2, maxQty: 2, matchedTitle: 'Belonging' }], copies: 2 }), null);
});
