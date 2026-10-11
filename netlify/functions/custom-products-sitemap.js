/**
 * Netlify Function: custom-products-sitemap
 * GET /.netlify/functions/custom-products-sitemap   (public)
 *
 * { urls: [{ slug, lastmod }] } -- the admin-added books the Worker appends to
 * sitemap.xml (utils/custom-sitemap). Product slugs are public already: every
 * one is a live page and is in /custom-feed.xml.
 */

const { createClient } = require('@supabase/supabase-js');
const { customProductUrls } = require('./utils/custom-sitemap');

exports.handler = async (event = {}) => {
  if (event.httpMethod && event.httpMethod !== 'GET') return { statusCode: 405, body: 'GET only' };
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const urls = await customProductUrls(supabase);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
      body: JSON.stringify({ urls }),
    };
  } catch (e) {
    console.error('[custom-products-sitemap]', e.message);
    return { statusCode: 503, headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: e.message }) };
  }
};
