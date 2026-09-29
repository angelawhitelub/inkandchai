const test = require('node:test');
const assert = require('node:assert/strict');
const { contentRewrite, patchJsonLd, descInner, bioBlock } = require('./catalog-content-render');
const { catalogueBook, overrideFor, cleanFields } = require('./catalog-content');
const { catalogueFeedId, feedId } = require('./feed-id');
const search = require('../admin-product-search')._test;

const SLUG = 'the-love-hypothesis-by-ali-hazelwood-32189';

test('a real catalogue slug resolves to its book; a custom slug does not', () => {
  const b = catalogueBook(SLUG);
  assert.ok(b);
  assert.match(b.title, /Love Hypothesis/);
  assert.equal(catalogueBook('not-a-real-book-99999'), null);
});

test('only what differs from the feed is stored; nothing different means delete', () => {
  const book = { description: 'Feed text.' };
  assert.equal(overrideFor(book, { description: 'Feed text.' }), null);
  assert.equal(overrideFor(book, { description: '  ', seo_title: '' }), null);
  const o = overrideFor(book, { description: 'Feed text.', author_bio: 'Ali writes STEM romance.' });
  assert.equal(o.description, null);
  assert.equal(o.author_bio, 'Ali writes STEM romance.');
  assert.equal(overrideFor(book, { description: 'New copy.\n\nSecond para.' }).description, 'New copy.\n\nSecond para.');
  assert.equal(cleanFields({ seo_title: 'x'.repeat(400) }).seo_title.length, 150);
});

test('rewrite: formatted description, meta from it, bio block, SEO title', () => {
  const rw = contentRewrite({ description: '**Olive** meets Adam.\n\n- STEM\n- fake dating', author_bio: 'Ali Hazelwood is a neuroscientist.', seo_title: 'The Love Hypothesis — Buy Online' });
  assert.equal(rw.title, 'The Love Hypothesis — Buy Online');
  assert.match(descInner(rw), /About this book<\/div><p><strong>Olive<\/strong> meets Adam\.<\/p><ul><li>STEM/);
  assert.match(bioBlock(rw), /About the author<\/div><p>Ali Hazelwood is a neuroscientist\.<\/p>/);
  assert.doesNotMatch(rw.meta, /\*/);
  assert.ok(rw.meta.length <= 155);
});

test('admin copy can never inject markup or break an attribute', () => {
  const rw = contentRewrite({ description: '<script>alert(1)</script> "quoted" <img onerror=x>' });
  assert.doesNotMatch(rw.descHtml, /<script|<img/);
  assert.doesNotMatch(rw.meta, /"/);
  const ld = patchJsonLd(JSON.stringify({ '@type': 'Book', name: 'x' }), rw);
  assert.doesNotMatch(ld, /<\/script/i);
  assert.equal(JSON.parse(ld).description.includes('<script>'), true);   // text, escaped as < in the page
});

test('JSON-LD: only the Book/Product block changes', () => {
  const rw = contentRewrite({ description: 'New.', tags: 'romance, stem' });
  const book = JSON.parse(patchJsonLd(JSON.stringify({ '@type': 'Book', description: 'Old' }), rw));
  assert.equal(book.description, 'New.');
  assert.equal(book.keywords, 'romance, stem');
  assert.equal(patchJsonLd(JSON.stringify({ '@type': 'FAQPage' }), rw), null);
  assert.equal(patchJsonLd('not json', rw), null);
});

test('an empty override changes nothing', () => {
  assert.equal(contentRewrite({}), null);
  assert.equal(contentRewrite(null), null);
});

test('Google item ids: catalogue keeps the shopify suffix at 50 chars, custom gets cp-', () => {
  assert.equal(catalogueFeedId(SLUG), SLUG);
  const long = 'love-theoretically-from-the-bestselling-author-of-the-love-hypothesis-by-ali-hazelwood-77437';
  const id = catalogueFeedId(long);
  assert.equal(id.length <= 50, true);
  assert.match(id, /-77437$/);
  assert.equal(feedId('short-slug'), 'cp-short-slug');
});

test('admin search: "Title by Author" finds a catalogue book', () => {
  const words = search.searchWords('The Love Hypothesis by Ali Hazelwood');
  assert.deepEqual(words, ['love', 'hypothesis', 'ali', 'hazelwood']);
  const hits = search.catalogueRows().filter((b) => search.matchesAll(b, words)).map((b) => b.slug);
  assert.ok(hits.includes(SLUG));
});

test('a "## heading" typed directly above its bullets still renders as heading + list', () => {
  const { richText } = require('./rich-text');
  assert.equal(richText('## Why readers love it\n- STEM romance\n- Fake dating'),
    '<h3>Why readers love it</h3><ul><li>STEM romance</li><li>Fake dating</li></ul>');
  // A sentence that merely starts with a hyphen is still not a list.
  assert.equal(richText('Plain\n- dash sentence'), '<p>Plain<br/>- dash sentence</p>');
});

test('book details: numbers are cleaned, re-saving the baked publisher/ISBN is not an override', () => {
  const b = catalogueBook(SLUG);
  const { pagePublisher } = require('./catalog-content');
  assert.equal(pagePublisher({ publisher: '99bookstore' }), '');            // supplier name never shown
  assert.equal(overrideFor(b, { publisher: pagePublisher(b), isbn: String(b.isbn || '') }), null);
  const f = cleanFields({ pages: '320', weight_grams: 'abc', publisher: '  Bloomsbury  ' });
  assert.equal(f.pages, 320);
  assert.equal(f.weight_grams, null);
  assert.equal(f.publisher, 'Bloomsbury');
  assert.equal(cleanFields({ pages: 0 }).pages, null);
  const o = overrideFor(b, { publisher: 'Bloomsbury', format: 'Hardcover' });
  assert.equal(o.publisher, 'Bloomsbury');
  assert.equal(o.format, 'Hardcover');
});

test('book details rewrite: Details rows in custom-page order, escaped, and in the Book JSON-LD', () => {
  const rw = contentRewrite({
    publisher: 'A <b>& Co', isbn: '9781408855652', format: 'Hardcover', language: 'Hindi',
    pages: 320, weight_grams: 1250, reading_age: '12+', edition: '2nd',
  });
  assert.equal(rw.descHtml, null);                    // copy untouched when only details change
  assert.equal(rw.details.publisher, 'A <b>& Co');   // Worker inserts it as TEXT (auto-escaped)
  assert.equal(rw.details.lead,
    '<dt>Format</dt><dd>Hardcover</dd><dt>Pages</dt><dd>320</dd><dt>Language</dt><dd>Hindi</dd><dt>Edition</dt><dd>2nd</dd>');
  assert.equal(rw.details.tail, '<dt>Weight</dt><dd>1.25 kg</dd><dt>Reading age</dt><dd>12+</dd>');
  const ld = JSON.parse(patchJsonLd(JSON.stringify({ '@type': 'Book', publisher: 'Ink & Chai', isbn: null }), rw));
  assert.equal(ld.publisher, 'A <b>& Co');
  assert.equal(ld.isbn, '9781408855652');
  assert.equal(ld.bookFormat, 'https://schema.org/Hardcover');
  assert.equal(ld.inLanguage, 'hi');
  assert.equal(ld.numberOfPages, 320);
  assert.ok(!patchJsonLd(JSON.stringify({ '@type': 'Book' }), rw).includes('<b>'));   // </script>-safe
  assert.equal(contentRewrite({ format: 'Hardcover' }).details.lead, '<dt>Format</dt><dd>Hardcover</dd>');
  assert.equal(contentRewrite({ pages: null, format: '' }), null);
});
