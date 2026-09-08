/**
 * Netlify Function: site-banners  (PUBLIC)
 * GET /.netlify/functions/site-banners
 *
 * What the homepage carousel should show beyond its built-in slides: which
 * built-ins the admin has switched off, and any banners published from Banner
 * Studio.
 *
 * Returns { hidden: ['builtin:sale', ...], slides: [{ slot, html }] }
 *
 * The stored row holds FIELDS, not markup -- the slide is rendered here on
 * every read through the same escaper the drafting tool uses. So nothing that
 * was ever typed into the admin reaches the homepage as live HTML, and a book
 * whose cover or title has changed shows the new one without republishing.
 *
 * Fails silent and empty. This runs on every homepage load; if the table does
 * not exist yet or the database is unreachable, the right answer is "no extra
 * banners", not an error on the front page.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const { renderSlide } = require('./utils/banner-slide');

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
  // Short enough that publishing feels immediate, long enough that the homepage
  // is not making a database call for every visitor.
  'Cache-Control': 'public, max-age=30, s-maxage=30',
};

const empty = () => ({ statusCode: 200, headers: HEADERS, body: JSON.stringify({ hidden: [], slides: [] }) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: HEADERS, body: 'Method Not Allowed' };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return empty();

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let rows;
  try {
    const { data, error } = await supabase
      .from('site_banners')
      .select('slot,kind,is_active,sort_order,fields,book_slugs')
      .order('sort_order', { ascending: true });
    if (error) throw error;
    rows = data || [];
  } catch (e) {
    console.warn('[site-banners] unavailable (serving none):', e.message);
    return empty();
  }

  const hidden = rows.filter(r => r.is_active === false).map(r => r.slot);
  const live = rows.filter(r => r.is_active !== false && r.kind === 'custom' && r.fields);

  // One query for every cover on every published banner, rather than one per
  // banner. There will rarely be more than a handful, but the homepage is the
  // wrong place to be casual about round trips.
  const wanted = [...new Set(live.flatMap(r => Array.isArray(r.book_slugs) ? r.book_slugs : []))];
  let bySlug = new Map();
  if (wanted.length) {
    try {
      const { data, error } = await supabase
        .from('custom_products')
        .select('slug,title,image_url')
        .in('slug', wanted);
      if (error) throw error;
      bySlug = new Map((data || []).map(b => [b.slug, b]));
    } catch (e) {
      console.warn('[site-banners] cover lookup failed:', e.message);
    }
  }

  const slides = [];
  for (const row of live) {
    // Keep the admin's chosen order; the first book is the featured cover.
    const books = (Array.isArray(row.book_slugs) ? row.book_slugs : [])
      .map(s => bySlug.get(s))
      .filter(Boolean)
      .map(b => ({ slug: b.slug, title: b.title || '', img: b.image_url || '' }));
    // A banner whose books have all been delisted is not rendered at all --
    // better a missing slide than a hero of empty cover frames.
    if (!books.length) continue;
    slides.push({ slot: row.slot, html: renderSlide(row.fields, books) });
  }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ hidden, slides }) };
};
