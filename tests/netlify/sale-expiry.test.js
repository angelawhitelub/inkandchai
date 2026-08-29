/**
 * A sale that has ended must disappear from the storefront on its own.
 *
 * The Freedom Sale ended on 15 Aug 2026 and the homepage advertised "15% OFF
 * ... Automatically applied" for a fortnight afterwards, with a dead countdown,
 * while checkout correctly refused the code. Every customer who arrived in that
 * window was promised a discount the till would not honour.
 *
 * The cause was that only one of four sale surfaces knew how to remove itself.
 * These tests pin the two independent layers that now remove all of them: the
 * build strips them, and the client strips whatever a cached page still shows.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const gen = fs.readFileSync(path.join(root, 'generate_site.py'), 'utf8');

test('every sale surface sits inside a strip marker', () => {
  // Four surfaces advertised the sale: the top bar, the standalone banner
  // section, the carousel slide, and that slide's navigation dot. A surface
  // outside a marker pair is one that will outlive the sale.
  // The strip regex itself contains both marker strings, so exclude that line.
  const markup = gen.split('\n').filter(l => !l.includes("re.sub(r'<!--SALE:START-->")).join('\n');
  const starts = (markup.match(/<!--SALE:START-->/g) || []).length;
  const ends = (markup.match(/<!--SALE:END-->/g) || []).length;
  assert.equal(starts, 4, 'four sale surfaces are wrapped');
  assert.equal(ends, starts, 'every marker is closed');
});

test('every sale deadline in the codebase is the same instant', () => {
  // The homepage, the product page and the checkout each carry their own copy
  // of the deadline, because they are generated into separate files with no
  // shared scope. They cannot be deduplicated cheaply, but they MUST agree:
  // one surface holding a later date is precisely how an ended sale keeps
  // advertising itself. This fails the moment they drift.
  const iso = gen.match(/SALE_END_ISO = '([^']+)'/);
  assert.ok(iso, 'the build declares a canonical sale end');
  const literals = gen.match(/2026-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g) || [];
  const saleLiterals = literals.filter(v => v.startsWith('2026-08-15'));
  assert.ok(saleLiterals.length >= 4, `expected the sale date in several places, saw ${saleLiterals.length}`);
  for (const v of saleLiterals) {
    assert.equal(v, iso[1], 'a sale deadline disagrees with SALE_END_ISO');
  }
});

test('the build strips the markers only after the sale ends', () => {
  const script = `
import sys, re
sys.path.insert(0, ${JSON.stringify(root)})
from datetime import datetime, timezone
src = open(${JSON.stringify(path.join(root, 'generate_site.py'))}).read()
ns = {'re': re}
start = src.index("SALE_END_ISO = ")
end = src.index("HTML = strip_expired_sale(HTML)")
exec(src[start:end], ns)
html = "keep <!--SALE:START-->SALE BANNER<!--SALE:END--> keep"
during = ns['strip_expired_sale'](html, datetime(2026, 8, 14, tzinfo=timezone.utc))
after  = ns['strip_expired_sale'](html, datetime(2026, 8, 16, tzinfo=timezone.utc))
print('DURING:' + during)
print('AFTER:' + after)
`;
  const out = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.match(out, /DURING:keep <!--SALE:START-->SALE BANNER<!--SALE:END--> keep/,
    'a running sale is left completely alone');
  assert.match(out, /AFTER:keep {2}keep/, 'an ended sale is stripped out');
});

test('the client removes every surface, not just the section', () => {
  // The original bug in one line: only #summerSale was removed.
  const fn = gen.slice(gen.indexOf('function removeExpiredSaleSurfaces()'));
  const body = fn.slice(0, fn.indexOf('\nfunction updateSaleCountdown'));
  for (const surface of ['promoBanner', 'summerSale', '.promo-slide.slide-sale']) {
    assert.ok(body.includes(surface), `${surface} is removed on expiry`);
  }
  // ...and the dot, or the carousel keeps a control that goes nowhere.
  assert.match(body, /dots\[slides\.indexOf\(slide\)\]\?\.remove\(\)/);
});

test('both expiry paths call the same removal', () => {
  // One path is "the countdown hit zero while the page was open", the other is
  // "the page was built before expiry and opened after". Both must clean up.
  const calls = (gen.match(/removeExpiredSaleSurfaces\(\)/g) || []).length;
  assert.ok(calls >= 3, `expected the helper plus both callers, saw ${calls}`);
});

test('the carousel still shows something once the sale slide is gone', () => {
  // The sale slide carried the `active` class in the markup. Strip it and the
  // carousel would open on a blank frame.
  assert.match(gen, /if \(!carousel\.querySelector\('\.promo-slide\.active'\)\) \{/);
});

// The generated homepage, when this checkout has one built.
const indexPath = path.join(root, 'public/index.html');
if (fs.existsSync(indexPath)) {
  const html = fs.readFileSync(indexPath, 'utf8');
  // Scripts legitimately still mention the sale (the removal helper names the
  // elements it deletes); what must be gone is the rendered markup.
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '');

  test('the built homepage advertises no ended sale', () => {
    assert.doesNotMatch(body, /FREEDOM SALE/i);
    assert.doesNotMatch(body, /15% OFF on orders above/i);
    assert.equal((html.match(/id="promoBanner"/g) || []).length, 0);
    assert.equal((html.match(/<section class="summer-sale-banner"/g) || []).length, 0);
  });

  test('the built carousel has as many dots as slides', () => {
    // Removing a slide without its dot leaves a control that navigates nowhere.
    const slides = (html.match(/<section class="[^"]*promo-slide[^"]*"/g) || []).length;
    const dots = (html.match(/<button class="promo-dot[^"]*"/g) || []).length;
    assert.equal(dots, slides, `${slides} slides but ${dots} dots`);
  });
}
