const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const fbt = fs.readFileSync(path.join(root, 'netlify/functions/frequently-bought.js'), 'utf8');
const builder = fs.readFileSync(path.join(root, 'scripts/build-fbt-signals.js'), 'utf8');
const netlifyToml = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');
const cartJs = fs.readFileSync(path.join(root, 'public/js/cart.js'), 'utf8');

test('the signal file is built at deploy time and shipped to the function', () => {
  assert.match(netlifyToml, /node scripts\/build-fbt-signals\.js/);
  // Without this the function reads its own bundle and finds nothing.
  assert.match(netlifyToml, /included_files = \["data\/ALL_BOOKS\.json", "data\/fbt-signals\.json"\]/);
});

test('a failed signal build cannot break the deploy', () => {
  // The whole recommender is a nice-to-have; the storefront is not.
  assert.match(builder, /\.catch\(\(err\) => \{/);
  assert.doesNotMatch(builder, /process\.exit\(1\)/);
});

test('only kept sales feed the recommender', () => {
  // Recommending a book that gets cancelled or sent back is worse than useless.
  const kept = builder.match(/const KEPT = new Set\(\[([\s\S]*?)\]\);/)[1];
  for (const bad of ['cancelled', 'rto', 'refunded', 'refund_pending', 'partially_refunded']) {
    assert.doesNotMatch(kept, new RegExp(`'${bad}'`), `${bad} orders must not feed recommendations`);
  }
  for (const good of ['delivered', 'shipped', 'paid']) {
    assert.match(kept, new RegExp(`'${good}'`));
  }
  // Our own re-shipments are not customer demand.
  assert.match(builder, /if \(isReplacement\(order\)\) continue;/);
});

test('bulk baskets do not swamp the pair counts', () => {
  // One 20-book order would otherwise contribute 190 pairs.
  assert.match(builder, /MAX_BASKET_FOR_PAIRS = 6/);
  assert.match(builder, /slugs\.length > MAX_BASKET_FOR_PAIRS\) continue;/);
});

test('a single co-purchase is treated as noise', () => {
  assert.match(builder, /MIN_PAIR = 2/);
  assert.match(builder, /if \(count < MIN_PAIR\) continue;/);
});

test('a real co-purchase outranks every similarity heuristic', () => {
  // The floor for a co-purchase (400) must exceed the most any similarity
  // signal can add: category 70 + hindi 18 + romance 16 + self 16 + author 55
  // + token overlap 48 + price 14 + promo 7 + hash 10 + bestseller 190 = 444.
  // A co-purchased pair starts at 400 AND collects the same bestseller boost,
  // so it cannot be beaten by a book that was never bought alongside this one.
  assert.match(fbt, /score \+= 400 \+ Math\.round\(Math\.log2\(together\) \* 120\)/);
});

test('popularity is capped so a bestseller cannot bury a genuine match', () => {
  assert.match(fbt, /Math\.min\(Math\.round\(Math\.log2\(sold \+ 1\) \* 22\), 190\)/);
});

test('the same book never appears twice in one panel', () => {
  // The catalogue holds duplicate slugs for the same title; without this the
  // panel filled with four copies of one book.
  assert.match(fbt, /function dedupeKey\(product\)/);
  assert.match(fbt, /takeDistinct\(ranked, limit/);
  // ...and the book being viewed cannot recommend itself under another slug.
  assert.match(fbt, /dedupeKey\(p\) !== dedupeKey\(base\)/);
});

test('an unknown slug falls back to what actually sells', () => {
  assert.match(fbt, /basis: 'bestsellers'/);
  assert.match(fbt, /\.map\(\(product\) => \(\{ product, sold: unitsSold\(signals, product\) \}\)\)/);
});

test('missing signals degrade to similarity instead of failing', () => {
  assert.match(fbt, /_signals = \{ pairs: \{\}, rank: new Map\(\), generatedAt: null \};/);
  assert.match(fbt, /const together = signals \? coBuyCount\(signals, base, candidate\) : 0;/);
});

test('the cart drawer shows the free-delivery gap and add-ons', () => {
  assert.match(cartJs, /function renderCartRecommendations\(\)/);
  assert.match(cartJs, /Add &#8377;\$\{need\.toLocaleString\('en-IN'\)\} more for FREE delivery/);
  // Redrawn from the one place that redraws the drawer, and never able to
  // break it.
  assert.match(cartJs, /try \{ renderCartRecommendations\(\); \} catch \(e\)/);
});

test('the cart never suggests something already in it', () => {
  assert.match(cartJs, /exclude=\$\{encodeURIComponent\(inCart\.join\(','\)\)\}/);
});

test('a slow recommendation cannot overwrite a newer cart', () => {
  // The customer can add or remove while the fetch is in flight.
  assert.match(cartJs, /if \(token !== _iacRecToken\) return;/);
});

// The shipped signal file, if this checkout has one built.
const signalPath = path.join(root, 'data/fbt-signals.json');
if (fs.existsSync(signalPath)) {
  const signals = JSON.parse(fs.readFileSync(signalPath, 'utf8'));

  test('the built signal file is shaped the way the function expects', () => {
    assert.ok(Array.isArray(signals.bestsellers), 'bestsellers is an array');
    assert.equal(typeof signals.pairs, 'object');
    for (const [slug, sold] of signals.bestsellers.slice(0, 20)) {
      assert.equal(typeof slug, 'string');
      assert.ok(sold > 0, `${slug} has no units`);
    }
  });

  test('pair lists are symmetric, sorted and capped', () => {
    const entries = Object.entries(signals.pairs);
    for (const [slug, partners] of entries.slice(0, 200)) {
      assert.ok(partners.length <= 8, `${slug} has ${partners.length} partners`);
      for (let i = 1; i < partners.length; i++) {
        assert.ok(partners[i - 1][1] >= partners[i][1], `${slug} partners are not sorted`);
      }
      for (const [partner, count] of partners) {
        assert.ok(count >= 2, `${slug}+${partner} kept a single co-purchase`);
        const back = signals.pairs[partner] || [];
        const mirrored = back.some(([other, n]) => other === slug && n === count);
        if (mirrored) continue;
        // Not mirrored is only acceptable when the partner's own list is FULL
        // and every partner it kept is at least as strong. A book like Atomic
        // Habits has more than 8 partners, so its weakest get trimmed from ITS
        // list while it stays in theirs — that is the cap working. Dropping a
        // strong pair while keeping a weaker one would be a build error.
        assert.equal(back.length, 8,
          `${slug} -> ${partner} is not mirrored back, and ${partner} had room for it`);
        const weakest = back[back.length - 1][1];
        assert.ok(weakest >= count,
          `${partner} dropped ${slug} (${count}) while keeping a weaker partner (${weakest})`);
      }
    }
  });
}
