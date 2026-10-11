'use strict';

/**
 * Admin-added books in sitemap.xml.
 *
 * sitemap.xml is baked by generate_site.py from the catalogue, so the books
 * created in the admin (custom_products) were never in it: 1,091 live product
 * pages Google could only find by following links. The Worker now serves
 * sitemap.xml with these appended (worker/index.js → custom-products-sitemap).
 *
 * Same set as /custom-feed.xml: active, curated listings. The bulk catalogue
 * imports (crossword, 99bookstores, bookstohome) stay out, as they do there.
 */

const SITE = 'https://inkandchai.in';

const xmlEscape = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Every active curated custom product: [{ slug, lastmod }]. */
async function customProductUrls(supabase) {
  const out = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await supabase.from('custom_products')
      .select('slug,updated_at')
      .eq('is_active', true)
      .not('tags', 'ilike', '%crossword-catalog%')
      .not('tags', 'ilike', '%99bookstores-catalog%')
      .not('tags', 'ilike', '%imported-bookstohome%')
      .order('slug', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data || []) {
      if (r.slug) out.push({ slug: r.slug, lastmod: String(r.updated_at || '').slice(0, 10) || null });
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

/**
 * The baked sitemap with these product URLs added before </urlset>. URLs the
 * sitemap already lists, and deleted slugs, are skipped. Pure.
 * @returns {{ xml: string, added: number }}
 */
function mergeSitemap(xml, urls, { deleted = new Set() } = {}) {
  const s = String(xml || '');
  const end = s.lastIndexOf('</urlset>');
  if (end < 0 || !Array.isArray(urls) || !urls.length) return { xml: s, added: 0 };
  const have = new Set([...s.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()));
  const lines = [];
  for (const u of urls) {
    const slug = String(u && u.slug || '').trim();
    if (!slug || deleted.has(slug.toLowerCase())) continue;
    const loc = `${SITE}/product/${encodeURIComponent(slug)}/`;
    if (have.has(loc)) continue;
    have.add(loc);
    const lastmod = /^\d{4}-\d{2}-\d{2}$/.test(u.lastmod || '') ? `<lastmod>${u.lastmod}</lastmod>` : '';
    lines.push(`  <url><loc>${xmlEscape(loc)}</loc>${lastmod}<changefreq>weekly</changefreq><priority>0.8</priority></url>`);
  }
  if (!lines.length) return { xml: s, added: 0 };
  return { xml: `${s.slice(0, end)}${lines.join('\n')}\n${s.slice(end)}`, added: lines.length };
}

module.exports = { customProductUrls, mergeSitemap };
