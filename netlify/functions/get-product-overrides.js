const { createClient } = require('@supabase/supabase-js');

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
      .select('slug,title,author,category,description,price_inr,original_price_inr,image_url,publisher,isbn,tags,is_active,updated_at')
      .eq('is_active', true)
      // EXCLUDE the full crossword.in catalogue (tagged 'crossword-catalog').
      // Those 8k+ books are browsed via the paginated /books page + catalog-search
      // endpoint, NOT loaded into the homepage BOOKS array. Pulling them here would
      // balloon this per-pageview feed to ~7 MB and blow Supabase egress.
      .not('tags', 'ilike', '%crossword-catalog%')
      .order('updated_at', { ascending: false });
    if (customError) console.warn('custom_products unavailable:', customError.message);
    else customProducts = (customData || []).map(p => ({
      ...p,
      // Search only needs a snippet; the >30-char ranking check still passes.
      description: String(p.description || '').slice(0, 300),
      // Client parses tags ONLY for /publisher-sourced-bestseller/. Keep that
      // marker, drop the rest (per-book tag lists were bulking the payload).
      tags: /publisher-sourced-bestseller/i.test(String(p.tags || '')) ? 'publisher-sourced-bestseller' : '',
    }));

    // Cache at CDN edge for 5 min; stale-while-revalidate keeps it snappy after expiry.
    // Product overrides change rarely (admin action), so 5-min staleness is fine.
    const cacheHeaders = { ...CORS, 'Cache-Control': 'public, max-age=300, stale-while-revalidate=60' };
    return { statusCode: 200, headers: cacheHeaders, body: JSON.stringify({ overrides: data || [], custom_products: customProducts }) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ overrides: [], warning: err.message }) };
  }
};
