/**
 * Netlify Function: ebook-library
 * GET → { ebooks: [...] } — everything this signed-in customer has bought.
 *
 * Joined against the ebooks table for the title and cover, so a delisted book
 * still appears in the library of someone who paid for it. Delisting stops new
 * sales; it does not take the book off the shelf of an existing customer.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireCustomer } = require('./utils/customer-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const who = await requireCustomer(event, db);
  if (who.error) return json(who.status, { error: who.error });

  try {
    const { data: rows, error } = await db.from('ebook_entitlements')
      .select('slug, created_at, downloads')
      .eq('user_id', who.user.id)
      .order('created_at', { ascending: false });
    if (error) { console.warn('[ebook-library]', error.message); return json(200, { ebooks: [] }); }
    if (!rows?.length) return json(200, { ebooks: [] });

    const { data: meta } = await db.from('ebooks')
      .select('slug, title, author, cover, pages, size_bytes')
      .in('slug', rows.map(r => r.slug));
    const bySlug = Object.fromEntries((meta || []).map(m => [m.slug, m]));

    return json(200, {
      ebooks: rows.map(r => ({
        slug: r.slug,
        title: bySlug[r.slug]?.title || r.slug,
        author: bySlug[r.slug]?.author || '',
        cover: bySlug[r.slug]?.cover || '',
        pages: bySlug[r.slug]?.pages || null,
        bought_at: r.created_at,
        downloads: r.downloads || 0,
      })),
    });
  } catch (e) {
    console.error('[ebook-library]', e.message);
    return json(500, { error: 'Could not load your library.' });
  }
};
