'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { renderSlide, esc } = require('../../netlify/functions/generate-banner-copy')._internals;

const BOOKS = [
  { slug: 'the-deal-pus-1', title: 'The Deal', img: 'https://cdn.example/deal.jpg' },
  { slug: 'the-mistake-pus-2', title: 'The Mistake', img: 'https://cdn.example/mistake.jpg' },
];

const FIELDS = {
  eyebrow: 'Elle Kennedy · Complete Series',
  title_line1: 'Off Campus',
  title_accent: 'all 5 books',
  title_line3: 'one order.',
  subtitle: 'Addictive college romance fans cannot stop rereading.',
  cta_label: 'Shop the set',
  cta_href: '/book-combos/',
  cta_secondary: 'More romance',
  cta_secondary_href: '/bestsellers/',
  price_label: '₹1,499',
  stats: [{ num: '5', label: 'books in one box' }, { num: '₹1,499', label: 'complete set' }, { num: 'COD', label: 'UPI available' }],
};

test('the slide uses the same classes the hand-written slides use', () => {
  // The carousel finds slides by .promo-slide and styles everything else by
  // class, so a drifting class name is an invisible break on the homepage.
  const html = renderSlide(FIELDS, BOOKS);
  for (const cls of ['hero promo-slide', 'hero-left', 'hero-eyebrow', 'hero-title',
                     'hero-sub', 'hero-ctas', 'hero-stats', 'hero-right', 'hero-cover-wall']) {
    assert.ok(html.includes(cls), `missing ${cls}`);
  }
  assert.ok(html.includes('<em>all 5 books</em>'), 'accent line must be the italic <em>');
});

test('every cover links to its own product page, first one featured', () => {
  const html = renderSlide(FIELDS, BOOKS);
  assert.ok(html.includes('href="/product/the-deal-pus-1/"'));
  assert.ok(html.includes('href="/product/the-mistake-pus-2/"'));
  assert.strictEqual((html.match(/hero-cover-card featured/g) || []).length, 1);
});

test('model text is escaped, so it cannot inject markup', () => {
  // The model never writes HTML; it fills text fields. This is what makes that
  // guarantee real rather than a hope.
  const nasty = {
    ...FIELDS,
    eyebrow: '<script>alert(1)</script>',
    title_accent: '" onload="steal()',
    subtitle: 'Tom & Jerry <b>bold</b>',
  };
  const html = renderSlide(nasty, BOOKS);
  assert.ok(!html.includes('<script>'), 'a script tag survived');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('Tom &amp; Jerry'));
  assert.ok(html.includes('&lt;b&gt;bold'), 'markup in the subtitle must be escaped, not rendered');
  // "onload=" survives as inert TEXT; what matters is that its quotes are
  // escaped so it can never become a real attribute.
  assert.ok(!/onload="/.test(html), 'an event handler became a real attribute');
  assert.ok(html.includes('onload=&quot;'), 'expected the quotes to be escaped');
});

test('a book title with quotes cannot break out of an attribute', () => {
  const html = renderSlide(FIELDS, [{ slug: 'x-1', title: 'He said "hi" & left', img: 'https://cdn.example/x.jpg' }]);
  assert.ok(html.includes('&quot;hi&quot;'));
  assert.ok(!/data-label="[^"]*"[^>]*"/.test(html), 'attribute was broken open');
});

test('a slug with characters needing encoding is encoded in the href', () => {
  const html = renderSlide(FIELDS, [{ slug: 'a b&c', title: 'T', img: 'i.jpg' }]);
  assert.ok(html.includes('/product/a%20b%26c/'));
});

test('the price label rides on the primary CTA, not invented by the model', () => {
  const html = renderSlide(FIELDS, BOOKS);
  assert.ok(html.includes('Shop the set — ₹1,499'));
  // With no price label the button is just the action, never a dangling dash.
  const noPrice = renderSlide({ ...FIELDS, price_label: '' }, BOOKS);
  assert.ok(noPrice.includes('>Shop the set</a>'));
  assert.ok(!noPrice.includes('— '));
});

test('exactly the three stats given are rendered', () => {
  const html = renderSlide(FIELDS, BOOKS);
  assert.strictEqual((html.match(/stat-num/g) || []).length, 3);
  const four = renderSlide({ ...FIELDS, stats: [...FIELDS.stats, { num: 'x', label: 'y' }] }, BOOKS);
  assert.strictEqual((four.match(/stat-num/g) || []).length, 3, 'must never render a fourth stat');
});

test('esc handles null and non-strings without throwing', () => {
  assert.strictEqual(esc(null), '');
  assert.strictEqual(esc(undefined), '');
  assert.strictEqual(esc(42), '42');
});
