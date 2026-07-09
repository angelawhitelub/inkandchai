/**
 * Rewrite a Supabase Storage public URL to our Netlify-cached proxy
 * (https://inkandchai.in/spimg/<key> → netlify/functions/img-proxy.js).
 *
 * Every endpoint that hands image URLs to a browser MUST route them through
 * this, or each pageview downloads the cover straight from Supabase Storage
 * and burns the "Cached Egress" quota (this is what blew the free-plan meter:
 * get-product-overrides feeds custom-product covers to every homepage visitor).
 *
 * Non-Supabase URLs (local /images, crossword.in, bookstohome.in, data URIs)
 * pass through untouched.
 */
function proxifySupabaseImage(url) {
  const raw = String(url || '');
  if (!raw || raw.startsWith('data:')) return raw;
  try {
    const supaHost = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).host : null;
    if (!supaHost) return raw;
    const u = new URL(raw);
    if (u.host !== supaHost) return raw;
    if (!u.pathname.startsWith('/storage/v1/object/public/')) return raw;
    const key = u.pathname.replace('/storage/v1/object/public/', '');
    return `https://inkandchai.in/spimg/${key}`;
  } catch {
    return raw; // relative path or malformed — leave as-is
  }
}

module.exports = { proxifySupabaseImage };
