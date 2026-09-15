const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normaliseSlug, validatePrice, validatePdfUpload, ebookKey, publicEbook, MAX_PDF_BYTES,
} = require('./ebook');
const { r2EbookConfig, r2PresignPut } = require('./r2-put');

test('a slug is reduced to the catalogue format', () => {
  assert.equal(normaliseSlug('  Atomic-Habits-ABC12 '), 'atomic-habits-abc12');
  assert.equal(normaliseSlug('../../etc/passwd'), 'etcpasswd');
  assert.equal(normaliseSlug('a b/c?d=e'), 'abcde');
  assert.equal(normaliseSlug(''), '');
  assert.equal(normaliseSlug(null), '');
});

test('a slug cannot escape the ebooks prefix', () => {
  // The key is built into an R2 path. A slug carrying slashes or dots would let
  // an admin write outside ebooks/, or read something else back out.
  const key = ebookKey('../../secrets', 'ab12');
  assert.ok(key.startsWith('ebooks/'), key);
  assert.ok(!key.includes('..'), key);
});

test('the object key is unguessable, and different every upload', () => {
  // The bucket is private, so this is defence in depth: if a public origin were
  // ever attached by mistake, ebooks/atomic-habits.pdf would be one guess away
  // from free. Two uploads of the same book must also not collide, or replacing
  // a PDF would overwrite the copy existing customers still download.
  const a = ebookKey('atomic-habits', 'aaaaaaaabbbbbbbb');
  const b = ebookKey('atomic-habits', 'ccccccccdddddddd');
  assert.notEqual(a, b);
  assert.match(a, /^ebooks\/atomic-habits\/[a-f0-9]+\.pdf$/);
});

test('a price must be whole rupees inside Razorpay-sane bounds', () => {
  assert.equal(validatePrice(199).price, 199);
  assert.equal(validatePrice('199').price, 199);   // form fields arrive as strings
  assert.equal(validatePrice(0).ok, false);        // Razorpay refuses a ₹0 order
  assert.equal(validatePrice(-50).ok, false);
  assert.equal(validatePrice(49.5).ok, false);     // paise the customer cannot see
  assert.equal(validatePrice('abc').ok, false);
  assert.equal(validatePrice(999999).ok, false);   // a typo, not a price
});

test('only PDFs, and only ones that fit', () => {
  assert.equal(validatePdfUpload({ contentType: 'application/pdf', sizeBytes: 5e6 }).ok, true);
  assert.equal(validatePdfUpload({ contentType: 'application/epub+zip', sizeBytes: 5e6 }).ok, false);
  assert.equal(validatePdfUpload({ contentType: 'image/png', sizeBytes: 100 }).ok, false);
  assert.equal(validatePdfUpload({ contentType: 'application/pdf', sizeBytes: 0 }).ok, false);
  assert.equal(validatePdfUpload({ contentType: 'application/pdf', sizeBytes: MAX_PDF_BYTES + 1 }).ok, false);
  assert.equal(validatePdfUpload({ contentType: 'APPLICATION/PDF', sizeBytes: 100 }).ok, true);
});

test('the public view of an eBook never carries the storage key', () => {
  // This is the whole security model in one assertion: r2_key is what turns a
  // listing into a download, and ebook-catalog.js is unauthenticated.
  const row = {
    slug: 'atomic-habits-abc12', title: 'Atomic Habits', price: 199,
    r2_key: 'ebooks/atomic-habits-abc12/deadbeef.pdf', size_bytes: 5242880,
  };
  const pub = publicEbook(row);
  assert.equal(pub.r2_key, undefined);
  assert.equal(JSON.stringify(pub).includes('deadbeef'), false);
  assert.equal(pub.price, 199);
  assert.equal(pub.size_mb, 5);
});

test('there is no way to mint a shareable link to a paid PDF', () => {
  // A presigned GET used to exist here and was removed on purpose: the URL was
  // a bearer token for the whole book, so forwarding it handed over the book.
  // Reads now go through ebook-file.js, which checks an entitlement per request.
  // This test exists to fail if anyone reintroduces the shortcut.
  const r2 = require('./r2-put');
  assert.equal(typeof r2.r2PresignGet, 'undefined');
  assert.equal(typeof r2.r2GetObject, 'function');
});

test('uploads can still be presigned, because only the admin does them', () => {
  // The asymmetry is deliberate. A PUT link lets one known admin push one key
  // for ten minutes and grants no read; a GET link would have been the file.
  const cfg = { accountId: 'a', accessKeyId: 'b', secretAccessKey: 'c', bucket: 'eb', publicBase: 'https://x.invalid' };
  const { uploadUrl } = r2PresignPut(cfg, { key: 'ebooks/x/abc.pdf', contentType: 'application/pdf' });
  assert.match(uploadUrl, /X-Amz-Signature=[0-9a-f]{64}/);
  assert.match(uploadUrl, /X-Amz-Expires=600/);
});

test('the ebook bucket config has no public base at all', () => {
  // r2Config REQUIRES a public origin; this one must never have one, or the
  // paid PDFs become as readable as the covers.
  const cfg = r2EbookConfig({ R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c' });
  assert.equal(cfg.publicBase, undefined);
  assert.equal(cfg.bucket, 'inkandchai-ebooks');
  assert.notEqual(cfg.bucket, 'inkandchai-images');
});
