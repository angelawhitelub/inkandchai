/**
 * Netlify Function: custom-products-feed
 * GET /custom-feed.xml  (via redirect → this function)
 *
 * Google Merchant Center product feed for admin-created products (the
 * `custom_products` table). These products are NOT in the static feed.xml
 * (which is built from ALL_BOOKS.json), so this serves them live from Supabase
 * — new products appear in Merchant on the next scheduled fetch, no deploy.
 *
 * Add the URL https://inkandchai.in/custom-feed.xml as a scheduled-fetch feed
 * in Merchant Center (India / English), alongside the main feed.xml.
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { skipFromFeed } = require('./utils/feed-image-filter');

const SITE = 'https://inkandchai.in';
const BRAND = 'Ink & Chai';

// Google Merchant caps g:id at 50 chars. Keep the readable "cp-<slug>" when it
// fits; otherwise fall back to a stable short hash so it stays unique and <= 50.
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

// Strip markdown (**bold**, headings) and collapse whitespace for the feed description.
function plainText(s, max = 4000) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')                                   // strip HTML tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#8217;|&rsquo;|&#39;|&apos;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;|&quot;/g, '"')
    .replace(/&#\d+;|&[a-z]+;/gi, ' ')                          // any remaining entities
    .replace(/\*\*/g, '').replace(/[#`]/g, '')                  // stray markdown, just in case
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

function priceText(value) {
  const n = Number(String(value || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? `${n.toFixed(2)} INR` : '';
}

exports.handler = async () => {
  // Durable shared edge cache — this 2.4 MB feed is pulled by Google Merchant /
  // Meta catalog on a schedule; serve it from the edge and rebuild from Supabase
  // at most ~once/hour instead of on every fetch/retry.
  const headers = {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'public, max-age=600',
    'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=3600, stale-while-revalidate=86400',
  };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 200, headers, body: emptyFeed() };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    // Curated listings only. The bulk crossword.in import (tag crossword-catalog,
    // ~13.5k rows) is EXCLUDED so the curated feed stays compact while pagination
    // default and silently drop newer listings like Heartstopper, and (b) bloat
    // this feed to ~35 MB (it's pulled repeatedly by Merchant/Meta). Newest first
    // so freshly-created products always appear.
    const products = [];
    const feedLimit = 1500;
    const pageSize = 1000;
    for (let from = 0; from < feedLimit; from += pageSize) {
      const to = Math.min(from + pageSize, feedLimit) - 1;
      const { data, error } = await supabase
        .from('custom_products')
        .select('slug,title,author,category,description,price_inr,original_price_inr,image_url,publisher,isbn,is_active,tags')
        .eq('is_active', true)
        .not('tags', 'ilike', '%crossword-catalog%')
        .not('tags', 'ilike', '%99bookstores-catalog%')
        .not('tags', 'ilike', '%imported-bookstohome%')
        .order('updated_at', { ascending: false })
        .range(from, to);
      if (error) throw error;
      products.push(...(data || []));
      if (!data || data.length < to - from + 1) break;
    }

    const productSlugs = products.map(product => product.slug).filter(Boolean);
    const overrideRows = [];
    for (let from = 0; from < productSlugs.length; from += 100) {
      const { data, error } = await supabase
        .from('product_overrides')
        .select('slug,price_inr,original_price_inr,is_active')
        .in('slug', productSlugs.slice(from, from + 100));
      if (error) throw error;
      overrideRows.push(...(data || []));
    }
    const overrideBySlug = new Map(overrideRows.map(row => [row.slug, row]));
    products.forEach(product => {
      const override = overrideBySlug.get(product.slug);
      if (!override || override.is_active === false) return;
      if (override.price_inr != null) product.price_inr = override.price_inr;
      if (override.original_price_inr != null) product.original_price_inr = override.original_price_inr;
    });

    const items = (products || []).map((p) => {
      const price = priceText(p.price_inr);
      if (!p.slug || !p.title || !p.image_url || !price) return '';  // skip incomplete rows
      // Skip tiny thumbnail covers (…_SX50) — Google Merchant disapproves them
      // as "image too small", and they can't be upscaled from source.
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
      const idTag = p.isbn
        ? `<g:identifier_exists>yes</g:identifier_exists><g:isbn>${xmlEscape(p.isbn)}</g:isbn>`
        : `<g:identifier_exists>no</g:identifier_exists>`;
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
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${xmlEscape(BRAND)} — Custom Products</title>
    <link>${SITE}</link>
    <description>Admin-created product listings.</description>
${items}
  </channel>
</rss>`;
    return { statusCode: 200, headers, body: feed };
  } catch (e) {
    console.error('custom-products-feed error:', e.message);
    return { statusCode: 200, headers, body: emptyFeed() };
  }
};

function emptyFeed() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel><title>${xmlEscape(BRAND)} — Custom Products</title><link>${SITE}</link><description>No products.</description></channel>
</rss>`;
}
