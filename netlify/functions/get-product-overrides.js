const { createClient } = require('@supabase/supabase-js');
const { proxifySupabaseImage } = require('./utils/supabase-img');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ overrides: [], warning: 'Supabase not configured' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const requestedSlug = String(event.queryStringParameters?.slug || '').trim().toLowerCase().slice(0, 180);
    if (requestedSlug) {
      const { data: single, error: singleError } = await supabase
        .from('product_overrides')
        .select('slug,title,author,category,price_inr,original_price_inr,image_url,gallery_images,scarcity,is_active,updated_at')
        .eq('slug', requestedSlug)
        .eq('is_active', true)
        .maybeSingle();
      if (singleError) throw singleError;
      const override = single ? {
        ...single,
        image_url: proxifySupabaseImage(single.image_url),
        gallery_images: (Array.isArray(single.gallery_images) ? single.gallery_images : [])
          .map(proxifySupabaseImage).filter(Boolean),
      } : null;
      return {
        statusCode: 200,
        headers: { ...CORS, 'Cache-Control': 'no-store, max-age=0' },
        body: JSON.stringify({ overrides: override ? [override] : [] }),
      };
    }
    const { data, error } = await supabase
      .from('product_overrides')
      .select('slug,title,author,category,price_inr,original_price_inr,image_url,scarcity,is_active,updated_at')
      .eq('is_active', true);

    if (error) {
      console.warn('product_overrides unavailable:', error.message);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ overrides: [], warning: error.message }) };
    }

    let customProducts = [];
    // Egress-critical: this endpoint is fetched on EVERY catalog/home page load.
    // The listing client (index.html customProductToBook) only needs card fields +
    // a short description for search indexing + the publisher-sourced flag. It does
    // NOT render full descriptions, seo_title, or meta_description — those live on
    // the individual product page, which has its own query (product-page.js). So we
    // drop seo_title/meta_description entirely, truncate description to a search
    // snippet, and collapse `tags` to just the one marker the client parses. This
    // takes the payload from ~2.1 MB to ~0.25 MB per page view (was our #1 egress
    // sink — 74% of the old payload was description/meta bytes nobody displayed).
    const { data: customData, error: customError } = await supabase
      .from('custom_products')
      .select('slug,title,author,category,description,price_inr,original_price_inr,image_url,publisher,isbn,tags,is_active,created_at,updated_at')
      .eq('is_active', true)
      // EXCLUDE the big browse-only catalogues (crossword.in + 99bookstores).
      // Those thousands of books are browsed via the paginated /books page +
      // catalog-search endpoint, NOT loaded into the homepage BOOKS array.
      // Pulling them into this per-pageview feed would balloon it to several MB
      // and blow Supabase egress. (99bookstores' newest ~150 are NOT tagged
      // browse-only, so they still appear here.)
      .not('tags', 'ilike', '%crossword-catalog%')
      .not('tags', 'ilike', '%99bookstores-catalog%')
      .order('updated_at', { ascending: false });
    if (customError) console.warn('custom_products unavailable:', customError.message);
    else customProducts = (customData || []).map(p => ({
      ...p,
      // CRITICAL: every visitor's browser loads these covers from whatever URL
      // we return here. Raw supabase.co URLs were burning Cached Egress on
      // every homepage view — route through the Netlify /spimg proxy instead.
      image_url: proxifySupabaseImage(p.image_url),
      // Search only needs a snippet; the >30-char ranking check still passes.
      // Trimmed 300→160: description is the largest variable field and is used
      // only for on-site search matching (never displayed on listing cards), so
      // a shorter snippet cuts this per-pageview payload ~30% with negligible
      // search-recall loss.
      description: String(p.description || '').slice(0, 160),
      // Client parses tags ONLY for /publisher-sourced-bestseller/. Keep that
      // marker, drop the rest (per-book tag lists were bulking the payload).
      tags: /publisher-sourced-bestseller/i.test(String(p.tags || '')) ? 'publisher-sourced-bestseller' : '',
    }));

    // Cache at CDN edge; product overrides change rarely (admin action).
    // Durable shared cache → this 0.75 MB per-pageview feed is rebuilt from
    // Supabase at most ~once/hour globally instead of once per edge per 5 min.
    // Browser cache raised 300s → 900s: this is fetched on EVERY pageview, so a
    // 5-minute browser TTL made one browsing session re-download it 4-5 times
    // (~78 KB each, 125 MB/day in aggregate). The edge already serves data up to
    // an hour old (s-maxage=3600), so a 15-minute browser cache adds no staleness
    // beyond what this endpoint already tolerates, and cuts repeat fetches ~3x.
    const cacheHeaders = {
      ...CORS,
      'Cache-Control': 'public, max-age=900, stale-while-revalidate=600',
      'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=3600, stale-while-revalidate=86400',
    };
    const overrides = (data || []).map(o => ({ ...o, image_url: proxifySupabaseImage(o.image_url) }));
    return { statusCode: 200, headers: cacheHeaders, body: JSON.stringify({ overrides, custom_products: customProducts }) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ overrides: [], warning: err.message }) };
  }
};
