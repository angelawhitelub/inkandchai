const test = require('node:test');
const assert = require('node:assert');
const { sourceAllowed, isShopify } = require('../admin-rehost-covers');

test('only Amazon and Open Library covers (or the placeholder) may be copied into R2', () => {
  assert.ok(sourceAllowed('https://m.media-amazon.com/images/I/41JXUQY-eRL._SL500_.jpg'));
  assert.ok(sourceAllowed('https://covers.openlibrary.org/b/isbn/9780143442295-L.jpg?default=false'));
  assert.ok(sourceAllowed('https://ia800505.us.archive.org/view_archive.php?archive=x'));
  assert.ok(sourceAllowed('placeholder'));
  assert.ok(!sourceAllowed('http://m.media-amazon.com/images/I/x.jpg'));
  assert.ok(!sourceAllowed('https://evil.example/m.media-amazon.com.jpg'));
  assert.ok(!sourceAllowed('https://m.media-amazon.com.evil.example/x.jpg'));
  assert.ok(!sourceAllowed('file:///etc/passwd'));
});

test('only Shopify-hosted covers are scanned', () => {
  assert.ok(isShopify('https://cdn.shopify.com/s/files/1/0777/8100/8701/files/x.jpg?v=1'));
  assert.ok(!isShopify('https://pub-e82e9bd0c7bd4d1eb2de92eb40d0dc33.r2.dev/x.webp'));
  assert.ok(!isShopify(null));
});
