/**
 * Precompute the checkout price index.
 *
 * resolveCartPrices needs, for every catalogue book, only {slug, title, price,
 * shippingRestrictions}. It used to build that at runtime by reading the whole
 * 5.7 MB data/ALL_BOOKS.json off the filesystem — which works on a Lambda and
 * does not exist on Cloudflare Workers, where there is no filesystem and no
 * bundle big enough to hold that file.
 *
 * Building the index here instead turns 5.7 MB of disk read per cold start into
 * a ~274 KB (87 KB gzipped) JSON module the bundler inlines. It is also strictly
 * faster on Netlify: no file IO, no 5,096-book parse on the checkout path.
 *
 * Run from the build command, before generate_site.py. Committed output is not
 * required — the build regenerates it — but it is committed so a checkout can
 * run the tests without a build first.
 */
const fs = require('fs');
const path = require('path');
const { makeSlug } = require('../netlify/functions/utils/pricing');
const { parseShippingRestrictionTags } = require('../netlify/functions/utils/shipping-restrictions');

const SRC = path.join(__dirname, '..', 'data', 'ALL_BOOKS.json');
const OUT = path.join(__dirname, '..', 'data', 'catalog-index.json');

function slugFromUrl(url) {
  const m = String(url || '').match(/\/product\/([^/?#]+)/);
  return m ? m[1].toLowerCase() : '';
}

function buildIndex(books) {
  const index = {};
  for (const b of books) {
    const price = Number.parseFloat(b.price_inr || 0) || 0;
    if (price <= 0) continue;
    const restrictions = parseShippingRestrictionTags(b.tags);
    const entry = { title: String(b.title || '').slice(0, 240), price };
    // Almost no catalogue book carries a tag-based shipping rule, and the ones
    // that do are migrating to product_shipping_rules. Only store the field when
    // it says something, or it triples the size of the index for nothing.
    if (restrictions && ((restrictions.states || []).length || (restrictions.pins || []).length)) {
      entry.shippingRestrictions = restrictions;
    }
    // Indexed under BOTH the computed slug (what generate_site.py names the
    // page) and the slug in the raw url (hand-curated CUSTOM listings), exactly
    // as the runtime build did.
    const computed = makeSlug(b.title || '', b.shopify_id || '').toLowerCase();
    if (computed) index[computed] = { ...entry, slug: computed };
    const urlSlug = slugFromUrl(b.url || '');
    if (urlSlug && urlSlug !== computed && !index[urlSlug]) index[urlSlug] = { ...entry, slug: urlSlug };
  }
  return index;
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('[catalog-index] data/ALL_BOOKS.json missing — leaving the existing index in place');
    process.exit(0);                       // never fail the build over this
  }
  const books = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const index = buildIndex(books);
  const json = JSON.stringify(index);
  fs.writeFileSync(OUT, json);
  console.log(`[catalog-index] ${Object.keys(index).length} slugs from ${books.length} books → ${Math.round(json.length / 1024)} KB`);
}

if (require.main === module) main();
module.exports = { buildIndex, slugFromUrl };
