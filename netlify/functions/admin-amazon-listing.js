/**
 * Netlify Function: admin-amazon-listing
 * POST /.netlify/functions/admin-amazon-listing   { url }   (admin)
 *
 * Create Listing → "🛒 Fill from Amazon": reads an Amazon.in book page and
 * returns the Create Listing form's fields. Saves NOTHING; the admin checks the
 * form, adds a cover and presses Create.
 *
 * Returns { ok, asin, fields, warnings, duplicate, mrp_source }.
 *   fields     every form field except the cover and gallery, which are left
 *              for the admin: Amazon's images are never used.
 *   duplicate  { kind: 'exact'|'near', title, slug } when we already list it.
 *
 * A Kindle link is followed to the book's Paperback, then Hardcover, because
 * that is what we sell. With no readable print edition the form still gets the
 * facts the eBook page has, with ISBN, M.R.P. and price left blank: an eBook's
 * price says nothing about the printed book, so none is guessed from it.
 *
 * Facts, price (M.R.P. − 40%) and the duplicate check are the bestseller
 * agent's (utils/bestseller-agent); the copy is drafted fresh by the model with
 * Amazon's blurb as facts only, never copied.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const agent = require('./utils/bestseller-agent');
const { parseAmazonInput, asinFromLocation, formFields } = require('./utils/amazon-listing');
const { loadCatalogue } = require('./bestseller-agent-scheduled');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

/** amzn.in/d/xyz → the ASIN it redirects to. */
async function resolveShortLink(shortUrl, fetchImpl) {
  let url = shortUrl;
  for (let hop = 0; hop < 4; hop += 1) {
    const res = await fetchImpl(url, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' } });
    const loc = res.headers.get('location');
    if (!loc) return '';
    const asin = asinFromLocation(new URL(loc, url).toString());
    if (asin) return asin;
    url = new URL(loc, url).toString();
  }
  return '';
}

/** One Amazon page, parsed; html is kept so a Kindle page's links can be read. */
async function readPage(asin, fetchImpl) {
  try {
    const { status, body: html } = await agent.fetchText(`https://www.amazon.in/dp/${asin}`, { fetchImpl });
    if (status !== 200) return { page: { ok: false, reason: `HTTP ${status}` }, html: '' };
    return { page: agent.parseProductPage(html, asin), html };
  } catch (e) {
    return { page: { ok: false, reason: e.name === 'AbortError' ? 'Amazon took too long' : e.message }, html: '' };
  }
}

/**
 * The page to fill the form from when the link was a Kindle edition, and the
 * note that says so: the first print edition that reads properly, else the
 * eBook page's own facts.
 */
async function fromKindle(kindleAsin, kindleHtml, fetchImpl) {
  const editions = agent.printEditions(kindleHtml);
  const failed = [];
  for (const edition of editions) {
    const { page } = await readPage(edition.asin, fetchImpl);
    if (page.ok) {
      const skipped = failed.length ? ` Skipped ${failed.join('; ')}.` : '';
      return {
        page,
        note: `That link was the Kindle edition, so this was filled from the ${edition.format} (${edition.asin}).${skipped} Check it is the edition you stock.`,
      };
    }
    failed.push(`${edition.format} ${edition.asin}: ${page.reason.replace(/^no ISBN.*/, 'no ISBN')}`);
  }
  const page = agent.parseProductPage(kindleHtml, kindleAsin, { kindleFacts: true });
  const why = failed.length ? `Its print editions could not be used (${failed.join('; ')})` : 'Amazon shows no print edition for it';
  return {
    page,
    note: `That link is a Kindle edition. ${why}, so this was filled from the Kindle page: enter the ISBN, format, weight, M.R.P. and price from the printed book.`,
  };
}

exports.handler = async (event = {}, context, deps = {}) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  const blocked = requireAdmin(event, CORS);
  if (blocked) return blocked;

  let body;
  try { body = JSON.parse(event.body || '{}') || {}; } catch { return json(400, { error: 'Invalid JSON' }); }
  const fetchImpl = deps.fetchImpl || fetch;

  const input = parseAmazonInput(body.url);
  if (input.error) return json(400, { error: input.error });
  let asin = input.asin;
  if (!asin) {
    try { asin = await resolveShortLink(input.shortUrl, fetchImpl); } catch { asin = ''; }
    if (!asin) return json(400, { error: 'Could not open that short link. Open it in the browser and paste the full amazon.in address.' });
  }

  // 1. The product page.
  const first = await readPage(asin, fetchImpl);
  let { page } = first;
  let kindleNote = '';
  if (!page.ok && page.reason === 'kindle edition') {
    const followed = await fromKindle(asin, first.html, fetchImpl);
    page = followed.page;
    kindleNote = followed.note;
    if (page.ok) asin = page.asin;
  }
  if (!page.ok) {
    const why = page.reason === 'blocked'
      ? 'Amazon showed a robot check instead of the page. Try again in a minute.'
      : /^HTTP 404/.test(page.reason) ? 'Amazon has no page for that product.'
        : /ISBN/.test(page.reason) ? 'That product has no ISBN, so it is not a print book.'
          : `Could not read the Amazon page (${page.reason}).`;
    return json(422, { error: why, asin });
  }

  // 2. Price, category, duplicate check and copy, side by side.
  const supabase = deps.db || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  // Kindle pages nest one level deeper: Kindle Store › Kindle eBooks › the shelf.
  const crumbs = page.kindle ? (page.breadcrumbs || []).slice(1) : page.breadcrumbs;
  const category = agent.categoryFor({ category: '' }, crumbs) || '';
  const title = agent.listingTitle(page.title, page.author);
  const [crossword, catalogue, copy] = await Promise.all([
    page.isbn13 ? agent.crosswordLookup(page.isbn13, { fetchImpl }) : null,
    (deps.loadCatalogue || loadCatalogue)(supabase).catch((e) => { console.warn('[admin-amazon-listing] catalogue:', e.message); return null; }),
    agent.draftCopy({ ...page, category }, {
      fetchImpl, apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_BESTSELLER_MODEL || 'gpt-4.1-mini',
    }),
  ]);

  const money = agent.decideMrp({ amazonMrp: page.mrp, amazonPrice: page.price, crosswordMrp: crossword && crossword.mrp });
  const price = agent.priceFromMrp(money.mrp);
  const warnings = [...(kindleNote ? [kindleNote] : []), ...money.warnings];
  if (!category) warnings.push(`Category not recognised from Amazon (${(crumbs || []).slice(1, 3).join(' › ') || 'none shown'}). Pick one.`);
  if (copy.error) warnings.push(`Description not drafted: ${copy.error}. Use ✨ Draft with AI.`);
  else if (copy.skipped) warnings.push(`Description not drafted: ${copy.skipped}.`);
  if (crossword && crossword.available === false) warnings.push('Out of stock at Crossword.');

  let duplicate = null;
  if (catalogue) {
    const hit = agent.matchCatalogue(agent.buildCatalogueIndex(catalogue), page);
    if (hit.kind) duplicate = { kind: hit.kind, title: hit.match.title, slug: hit.match.slug, source: hit.match.source };
  } else {
    warnings.push('Could not check the catalogue for duplicates.');
  }

  console.log(`[admin-amazon-listing] ${asin} ${page.isbn13} mrp=${money.mrp}(${money.source}) dup=${duplicate ? duplicate.kind : 'none'}`);
  return json(200, {
    ok: true,
    asin,
    amazon_title: page.title,
    mrp_source: money.source,
    fields: formFields(page, { title, category, money, price, copy }),
    duplicate,
    warnings,
  });
};

exports.resolveShortLink = resolveShortLink;
