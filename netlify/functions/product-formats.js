/**
 * Netlify Function: product-formats   (public)
 * GET ?slug=…  →  { slug, formats: [ … ] }
 *
 * Every format one book is sold in, for the Amazon-style format strip on a
 * product page: the print edition you are looking at, any other print edition
 * linked to it (a hardcover, a Hindi translation), and the eBook if there is one.
 *
 * WHY THE PRINT EDITIONS ARE LINKS AND THE EBOOK IS NOT
 * Another print edition is a different product with its own page, stock, cart
 * line and SEO -- selecting it should take you there, exactly as Amazon moves
 * you to a different ASIN. The eBook is not a product row at all; it is the same
 * book in another wrapper, so it swaps the buy box in place with no navigation.
 *
 * Degrades to silence, never to an error. A missing product_editions table (the
 * migration has not been run) or a missing ebooks row must read as "this book
 * has one format", which is what the front end already draws today: nothing.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const { publicEbook, normaliseSlug } = require('./utils/ebook');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  // Same 120s as ebook-catalog: a price edit shows up quickly, but a product
  // page is not a database read per view.
  'Cache-Control': 'public, max-age=120',
  'Netlify-CDN-Cache-Control': 'public, s-maxage=300',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// What a print row is called when nobody has said. The catalogue is paperback
// almost end to end, and the Schema.org bookFormat on every product page
// already claims Paperback, so this keeps the strip agreeing with the markup.
const DEFAULT_PRINT_LABEL = 'Paperback';

const MAX_EDITIONS = 6;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function printFormat(row, { current }) {
  return {
    kind: 'print',
    slug: row.slug,
    title: row.title || '',
    label: String(row.format || '').trim() || DEFAULT_PRINT_LABEL,
    price: num(row.price_inr),
    mrp: num(row.original_price_inr),
    url: `/product/${row.slug}/`,
    current: !!current,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const slug = normaliseSlug((event.queryStringParameters || {}).slug);
  if (!slug) return json(200, { slug: '', formats: [] });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return json(200, { slug, formats: [] });
  }

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const COLS = 'slug,title,format,price_inr,original_price_inr,is_active';

  try {
    // ── The print edition being viewed ────────────────────────────────────
    const { data: self } = await db
      .from('custom_products').select(COLS).eq('slug', slug).maybeSingle();

    const formats = [];
    if (self) formats.push(printFormat(self, { current: true }));

    // ── Other print editions of the same work ─────────────────────────────
    // Two hops: find this slug's group, then everything else in it. Errors are
    // swallowed on purpose -- before the migration this table does not exist.
    let siblings = [];
    try {
      const { data: mine, error: e1 } = await db
        .from('product_editions').select('group_key').eq('slug', slug).maybeSingle();
      if (!e1 && mine?.group_key) {
        const { data: group, error: e2 } = await db
          .from('product_editions').select('slug,sort')
          .eq('group_key', mine.group_key)
          .order('sort', { ascending: true })
          .limit(MAX_EDITIONS + 1);
        if (!e2 && group?.length) {
          const others = group.map(r => r.slug).filter(s => s && s !== slug).slice(0, MAX_EDITIONS);
          if (others.length) {
            const { data: rows } = await db
              .from('custom_products').select(COLS).in('slug', others);
            // Keep the group's own order; `in` does not promise one.
            const bySlug = new Map((rows || []).map(r => [r.slug, r]));
            siblings = others.map(s => bySlug.get(s))
              .filter(r => r && r.is_active !== false)
              .map(r => printFormat(r, { current: false }));
          }
        }
      }
    } catch (e) {
      console.warn('[product-formats] editions:', e.message);
    }
    formats.push(...siblings);

    // ── The eBook ─────────────────────────────────────────────────────────
    try {
      const { data: eb, error } = await db
        .from('ebooks').select('*').eq('slug', slug).eq('active', true).maybeSingle();
      if (!error && eb) {
        const pub = publicEbook(eb);
        formats.push({
          kind: 'ebook',
          slug: pub.slug,
          title: pub.title,
          label: 'eBook',
          price: num(pub.price),
          mrp: num(pub.mrp),
          pages: pub.pages,
          size_mb: pub.size_mb,
          url: `/ebooks/?buy=${encodeURIComponent(pub.slug)}`,
          current: false,
        });
      }
    } catch (e) {
      console.warn('[product-formats] ebook:', e.message);
    }

    // One format is not a choice. Saying so lets the front end render nothing
    // rather than a lone chip that does nothing when you press it.
    if (formats.length < 2) return json(200, { slug, formats: [] });

    return json(200, { slug, formats });
  } catch (e) {
    console.error('[product-formats]', e.message);
    return json(200, { slug, formats: [] });
  }
};
