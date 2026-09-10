'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { renderSlide, LAYOUT_IDS, DEFAULT_LAYOUT } = require('./banner-slide');
const { renderSplit } = require('./banner-split');
const { PALETTE_IDS, palette } = require('./banner-palettes');

const BOOKS = [
  { slug: 'our-perfect-storm', title: 'Our Perfect Storm', img: '/img/a.jpg' },
  { slug: 'the-divorce', title: 'The Divorce', img: '/img/b.jpg' },
];

const FIELDS = {
  eyebrow: 'The reading room',
  title_line1: 'A little escape.',
  title_line3: 'A great',
  title_accent: 'book.',
  subtitle: 'For late nights and slow Sundays.',
  cta_label: 'Find your next read',
  cta_href: '/bestsellers/',
  cta_secondary: 'On our bedside table',
  cta_secondary_href: '/bestsellers/',
  footnote: 'Hindi & English',
  panel_eyebrow: 'One more chapter',
  sticker_line1: 'Stay in.',
  sticker_line2: 'Read on.',
  stats: [{ num: '2', label: 'books' }],
};

test('a banner with no layout still renders the classic hero', () => {
  const html = renderSlide({ ...FIELDS }, BOOKS);
  assert.ok(html.includes('hero-cover-wall'), 'should be the classic slide');
});

test('a layout id nobody has a renderer for falls back rather than throwing', () => {
  for (const bogus of ['', 'poster', '<script>', 'SPLIT ', null, 42, {}]) {
    const html = renderSlide({ ...FIELDS, layout: bogus }, BOOKS);
    assert.ok(html.includes('promo-slide'), `bogus layout ${String(bogus)} still renders`);
  }
});

test('every declared layout renders every declared palette', () => {
  for (const layout of LAYOUT_IDS) {
    for (const p of PALETTE_IDS) {
      const html = renderSlide({ ...FIELDS, layout, palette: p }, BOOKS);
      assert.ok(html.includes('class="hero promo-slide'), `${layout}/${p} produces a slide`);
    }
  }
});

test('the split layout carries its own stylesheet inside the section', () => {
  // The homepage lifts out the .promo-slide element and drops its siblings, so
  // a <style> beside the section would never reach the page.
  const html = renderSplit(FIELDS, BOOKS);
  const open = html.indexOf('<section');
  const close = html.lastIndexOf('</section>');
  const style = html.indexOf('<style>');
  assert.ok(style > open && style < close, 'the <style> must sit inside the section');
});

test('split closes the headline with the accent instead of stacking three lines', () => {
  const html = renderSplit(FIELDS, BOOKS);
  assert.ok(html.includes('A great <em>book.</em>'), 'accent closes the second line');
});

test('a book title cannot inject markup through any layout', () => {
  const nasty = [{ slug: 'x"><script>alert(1)</script>', title: '<img src=x onerror=alert(1)>', img: '"><b>' }];
  for (const layout of LAYOUT_IDS) {
    const html = renderSlide({ ...FIELDS, layout }, nasty);
    assert.ok(!html.includes('<script>alert'), `${layout} escapes the slug`);
    assert.ok(!html.includes('<img src=x onerror'), `${layout} escapes the title`);
  }
});

test('model text cannot inject markup or break out of the style attribute', () => {
  const html = renderSplit({
    ...FIELDS,
    eyebrow: '"><script>alert(1)</script>',
    footnote: '</style><script>alert(2)</script>',
    palette: '"><script>alert(3)</script>',
  }, BOOKS);
  assert.ok(!html.includes('<script>alert'), 'no script survives');
  assert.ok(html.includes('--sp-paper:'), 'an unknown palette falls back to a real one');
});

// The stylesheet names every class the layout can ever draw, so "is this
// element present" has to be asked of the markup, not of the whole string.
const markupOnly = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, '');

test('optional split fields are dropped rather than left as empty furniture', () => {
  const bare = { title_line1: 'The books', title_line3: 'everyone is', title_accent: 'reading.', cta_label: 'Shop' };
  const html = markupOnly(renderSplit(bare, BOOKS.slice(0, 1)));
  assert.ok(!html.includes('bnr-sp-sticker'), 'no sticker without sticker text');
  assert.ok(!html.includes('bnr-sp-foot'), 'no footnote without footnote text');
  assert.ok(html.includes('bnr-sp-cta'), 'the button is always there');
});

test('the sticker appears as soon as either of its lines is filled', () => {
  const one = markupOnly(renderSplit({ ...FIELDS, sticker_line2: '' }, BOOKS));
  assert.ok(one.includes('bnr-sp-sticker'), 'one line is enough');
  const none = markupOnly(renderSplit({ ...FIELDS, sticker_line1: '', sticker_line2: '' }, BOOKS));
  assert.ok(!none.includes('bnr-sp-sticker'), 'neither line means no sticker');
});

test('split shows at most three covers however many are picked', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ slug: 's' + i, title: 'T' + i, img: '/i' + i + '.jpg' }));
  const html = renderSplit(FIELDS, many);
  assert.strictEqual((html.match(/class="bnr-sp-cover"/g) || []).length, 3);
});

test('every palette defines every colour a layout asks for', () => {
  const needed = ['paper', 'ink', 'muted', 'panel', 'panelInk', 'panelSoft', 'sticker', 'stickerInk', 'btn', 'btnInk', 'label'];
  for (const id of PALETTE_IDS) {
    const p = palette(id);
    for (const key of needed) {
      assert.ok(p[key], `${id} is missing ${key}`);
    }
  }
});

test('the default layout is one that exists', () => {
  assert.ok(LAYOUT_IDS.includes(DEFAULT_LAYOUT));
});
