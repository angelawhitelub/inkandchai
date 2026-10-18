/**
 * Netlify Function: get-marketplace-links   (public)
 *
 *   GET ?slug=…   → { links: { amazon_url?, flipkart_url? } | null }
 *
 * public/js/marketplace-links.js asks this on every product page and shows the
 * "also on Amazon / Flipkart" buttons only for the links that are set. Same for
 * every visitor, so it is edge-cached; admin-marketplace-links purges it on save.
 */

const { createClient } = require('@supabase/supabase-js');
const M = require('./utils/marketplace-links');

const JSON_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=0, must-revalidate',
  'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=300, stale-while-revalidate=86400',
  'Netlify-Cache-Tag': 'products',
};
const json = (statusCode, body, extra = {}) => ({ statusCode, headers: { ...JSON_HEADERS, ...extra }, body: JSON.stringify(body) });
const NONE = { links: null };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: JSON_HEADERS, body: '' };
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });
  const slug = M.cleanSlug((event.queryStringParameters || {}).slug);
  if (!slug) return json(400, { error: 'Missing product slug' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return json(200, NONE);

  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data, error } = await db.from(M.TABLE).select('slug,amazon_url,flipkart_url,updated_at').eq('slug', slug).maybeSingle();
    if (error) throw error;
    return json(200, { links: M.publicLinks(data) });
  } catch (e) {
    // A missing migration or a Supabase blip must not break product pages.
    if (!M.isMissingTable(e)) console.warn('[get-marketplace-links]', e.message);
    return json(200, NONE, { 'Netlify-CDN-Cache-Control': 'public, s-maxage=30' });
  }
};
