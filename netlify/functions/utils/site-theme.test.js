const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applySiteTheme, THEME_BLOCK } = require('./site-theme');
const { richText, plainText } = require('./rich-text');

const ROOT = path.join(__dirname, '..', '..', '..');

test('the theme block is the one baked pages carry, and its stylesheet exists', () => {
  const baked = fs.readFileSync(path.join(ROOT, 'public', '404.html'), 'utf8');
  assert.ok(baked.includes(THEME_BLOCK), 'run `npm run routes` after site_theme.py');
  const href = THEME_BLOCK.match(/href="(\/css\/theme-[0-9a-f]+\.css)"/)[1];
  assert.ok(fs.existsSync(path.join(ROOT, 'public', href)));
});

test('applySiteTheme: last in <head>, once, idempotent; light class only without a theme switch', () => {
  const page = '<!doctype html><html lang="en"><head><style>a{}</style></head><body></body></html>';
  const once = applySiteTheme(page);
  assert.equal(applySiteTheme(once), once);
  assert.equal(once.split('<!--IAC-THEME-->').length, 2);
  assert.ok(once.indexOf(THEME_BLOCK) > once.indexOf('<style>'));
  assert.match(once, /<html lang="en" class="iac-light">/);

  const switched = applySiteTheme('<html><head><script>localStorage.getItem("iac_theme")</script></head></html>');
  assert.doesNotMatch(switched, /iac-light/);
  assert.equal(applySiteTheme('no head here'), 'no head here');
});

test('product-page.js wraps its HTML in the theme, and no longer loads site-feedback.js itself', () => {
  const src = fs.readFileSync(path.join(ROOT, 'netlify', 'functions', 'product-page.js'), 'utf8');
  assert.match(src, /applySiteTheme\(productHtml\(/);
  assert.ok(!src.includes('<script src="/js/site-feedback.js"'), 'the theme block loads it; twice would render the card twice');
});

test('HTML descriptions render as formatting, not as literal tags, and stay safe', () => {
  const d = '<p><strong>Book Scavenger</strong> is genuine &amp; new.</p><p>Line<br>two</p><ul><li>One</li><li>Two</li></ul><script>alert(1)</script><img src=x onerror=alert(1)>';
  assert.equal(richText(d), '<p><strong>Book Scavenger</strong> is genuine &amp; new.</p><p>Line<br/>two</p><ul><li>One</li><li>Two</li></ul>');
  assert.equal(plainText(d), 'Book Scavenger is genuine & new. Line two One Two');
  assert.equal(richText('Plain **bold**\n\nI <3 books'), '<p>Plain <strong>bold</strong></p><p>I &lt;3 books</p>', 'non-HTML copy is unchanged');
});
