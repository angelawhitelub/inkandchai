/**
 * Netlify Function: custom-products-feed-bulk
 * GET /custom-feed-bulk/:page   (redirect → this function?page=N)
 *
 * Google Merchant Center feed for the BULK-IMPORTED catalog (crossword.in,
 * 99bookstores, bookstohome imports in `custom_products`). These are excluded
 * from /custom-feed.xml on purpose — all together they'd be a ~35 MB feed,
 * which exceeds Netlify's 6 MB function response limit. So this feed is
 * PAGINATED: register each page as its own scheduled-fetch feed in Merchant
 * Center (India / English):
 *
 *   https://inkandchai.in/custom-feed-bulk/1
 *   https://inkandchai.in/custom-feed-bulk/2
 *   ...up to the page count printed in the XML comment at the top of page 1.
 *
 * Pages beyond the catalog return a valid empty feed, so registering a few
 * spare pages is harmless — new imports flow in without touching Merchant.
 *
 * Ordering is by slug ASC (stable), so products don't shuffle between pages
 * across fetches. Descriptions are trimmed to keep each page well under the
 * response limit.
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { skipFromFeed } = require('./utils/feed-image-filter');
const { identifierXml } = require('./utils/gtin');

const SITE = 'https://inkandchai.in';
const BRAND = 'Ink & Chai';
const PAGE_SIZE = 2000;          // items per feed page (~2-3 MB of XML)
const DESC_MAX = 600;            // Merchant only needs a short description

// Same tags custom-products-feed.js excludes — this feed serves exactly those.
const BULK_TAGS = ['crossword-catalog', '99bookstores-catalog', 'imported-bookstohome'];

function feedId(slug) {
  const id = `cp-${slug}`;
  if (id.length <= 50) return id;
  return `cp-${crypto.createHash('sha1').update(String(slug)).digest('hex').slice(0, 20)}`;
}

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function plainText(s, max = DESC_MAX) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#8217;|&rsquo;|&#39;|&apos;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;|&quot;/g, '"')
    .replace(/&#\d+;|&[a-z]+;/gi, ' ')
    .replace(/\*\*/g, '').replace(/[#`]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

function priceText(value) {
  const n = Number(String(value || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? `${n.toFixed(2)} INR` : '';
}

function bulkFilter(q) {
  // tags ilike any of the bulk-import markers
  return q.or(BULK_TAGS.map(t => `tags.ilike.%${t}%`).join(','));
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
    // Durable edge cache: Google/Meta re-fetch on a schedule; rebuild at most
    // every 6h — the bulk catalog changes only when an import runs.
    // Was s-maxage=21600 + SWR=86400: a bulk price change could take 30 hours to
    // reach Google. Each page rebuilds in ~1.5s, so this is affordable.
    'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=900, stale-while-revalidate=1800',
  };
  // Netlify rewrites don't reliably forward the ?page= from the redirect rule
  // to the function, so read the page number from the pretty URL itself
  // (/custom-feed-bulk/5) first, then fall back to the query string.
  const pathMatch = String(event.rawUrl || event.path || '').match(/custom-feed-bulk\/(\d+)/);
  const page = Math.max(1, parseInt(pathMatch ? pathMatch[1] : (event.queryStringParameters || {}).page, 10) || 1);

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 200, headers, body: emptyFeed(page) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { count, error: countErr } = await bulkFilter(
      supabase.from('custom_products')
        .select('slug', { count: 'exact', head: true })
        .eq('is_active', true)
    );
    if (countErr) throw countErr;
    const total = count || 0;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    // Supabase caps a single .range() at 1000 rows regardless of the span
    // requested, so fetch the 2000-item page in 1000-row chunks.
    const offset = (page - 1) * PAGE_SIZE;
    const products = [];
    for (let from = offset; from < offset + PAGE_SIZE; from += 1000) {
      const to = Math.min(from + 1000, offset + PAGE_SIZE) - 1;
      const { data, error } = await bulkFilter(
        supabase.from('custom_products')
          .select('slug,title,author,category,description,price_inr,original_price_inr,image_url,publisher,isbn,tags')
          .eq('is_active', true)
      ).order('slug', { ascending: true }).range(from, to);
      if (error) throw error;
      products.push(...(data || []));
      if (!data || data.length < to - from + 1) break;
    }

    const items = products.map((p) => {
      const price = priceText(p.price_inr);
      if (!p.slug || !p.title || !p.image_url || !price) return '';
      // Skip tiny thumbnail covers — Merchant disapproves "image too small".
      if (/\._S[XY](?:\d{1,2}|1\d\d)[_.]/.test(String(p.image_url))) return '';
      // Skip "coming soon" / supplier-branded placeholders — Merchant rejects
      // them as "Promotional overlay on image" (logo + text, not a real cover).
      // Rules are shared with feed.xml via utils/feed-image-filter.json.
      if (skipFromFeed({ slug: p.slug, imageUrl: p.image_url })) return '';
      const link = `${SITE}/product/${encodeURIComponent(p.slug)}/`;
      const desc = plainText(p.description) || `Buy ${p.title} online at ${BRAND}. Fast pan-India delivery, COD and prepaid available.`;
      const salePrice = priceText(p.original_price_inr);
      const hasSale = salePrice && Number(p.original_price_inr) > Number(p.price_inr);
      const brand = xmlEscape(p.publisher || p.author || BRAND);
      // g:isbn is not a Merchant attribute — see utils/gtin. The ISBN becomes a
      // g:gtin, and only when it is genuinely valid.
      const idTag = identifierXml(p.isbn);
      return `    <item>
      <g:id>${xmlEscape(feedId(p.slug))}</g:id>
      <g:title>${xmlEscape(p.title)}</g:title>
      <g:description>${xmlEscape(desc)}</g:description>
      <g:link>${xmlEscape(link)}</g:link>
      <g:image_link>${xmlEscape(p.image_url)}</g:image_link>
      <g:condition>new</g:condition>
      <g:availability>in stock</g:availability>
      ${hasSale ? `<g:price>${xmlEscape(salePrice)}</g:price>\n      <g:sale_price>${xmlEscape(price)}</g:sale_price>` : `<g:price>${xmlEscape(price)}</g:price>`}
      <g:brand>${brand}</g:brand>
      <g:google_product_category>Media &gt; Books</g:google_product_category>
      <g:product_type>${xmlEscape(p.category || 'Books')}</g:product_type>
      ${idTag}
    </item>`;
    }).filter(Boolean).join('\n');

    const feed = `<?xml version="1.0" encoding="UTF-8"?>
<!-- bulk catalog feed: page ${page} of ${totalPages} (${total} active bulk products, ${PAGE_SIZE}/page) -->
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${xmlEscape(BRAND)} — Bulk Catalog (page ${page})</title>
    <link>${SITE}</link>
    <description>Imported catalog listings, page ${page} of ${totalPages}.</description>
${items}
  </channel>
</rss>`;
    return { statusCode: 200, headers, body: feed };
  } catch (e) {
    console.error('custom-products-feed-bulk error:', e.message);
    return { statusCode: 200, headers, body: emptyFeed(page) };
  }
};

function emptyFeed(page) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel><title>${xmlEscape(BRAND)} — Bulk Catalog (page ${page})</title><link>${SITE}</link><description>No products on this page.</description></channel>
</rss>`;
}
