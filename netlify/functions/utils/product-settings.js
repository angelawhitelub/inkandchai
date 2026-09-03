/**
 * product_settings — the per-product fields that must NOT be undone by the
 * admin's "Disable Override" switch: the live price/MRP, and the handling time.
 *
 * See sql/product_settings.sql. Every read here tolerates the table not being
 * there yet: a missing migration must cost the new fields only, never take the
 * existing overrides off the storefront.
 */
const MAX_HANDLING_DAYS = 30;

/** True when PostgREST rejected the query because the table does not exist. */
function isMissingTable(error) {
  const msg = String((error && error.message) || '');
  const code = String((error && error.code) || '');
  return code === '42P01' || /relation .*product_settings.* does not exist/i.test(msg)
    || (/product_settings/.test(msg) && /does not exist|could not find/i.test(msg));
}

/**
 * Extra days before dispatch. Blank/absent/0 means the store default, so it is
 * normalised to null and callers can treat "no opinion" and "default" alike.
 */
function handlingDays(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const days = Math.max(0, Math.min(MAX_HANDLING_DAYS, Math.round(n)));
  return days === 0 ? null : days;
}

const COLUMNS = 'slug,price_inr,original_price_inr,handling_days,updated_at';

function normalizeRow(row) {
  if (!row || !row.slug) return null;
  const price = row.price_inr === null || row.price_inr === undefined ? null : Number(row.price_inr);
  const mrp = row.original_price_inr === null || row.original_price_inr === undefined ? null : Number(row.original_price_inr);
  return {
    slug: String(row.slug).toLowerCase(),
    price_inr: Number.isFinite(price) && price > 0 ? price : null,
    original_price_inr: Number.isFinite(mrp) && mrp > 0 ? mrp : null,
    handling_days: handlingDays(row.handling_days),
  };
}

/**
 * Fetch settings for the given slugs (or all of them when `slugs` is omitted),
 * keyed by lowercase slug. Returns {} when the table is missing or the query
 * fails — the caller then behaves exactly as it did before this table existed.
 */
async function fetchSettings(supabase, slugs) {
  if (!supabase) return {};
  if (Array.isArray(slugs) && !slugs.length) return {};
  try {
    let query = supabase.from('product_settings').select(COLUMNS);
    if (Array.isArray(slugs)) query = query.in('slug', slugs);
    const { data, error } = await query;
    if (error) {
      if (!isMissingTable(error)) console.warn('[product_settings] lookup:', error.message);
      return {};
    }
    const bySlug = {};
    for (const row of (data || [])) {
      const clean = normalizeRow(row);
      if (clean) bySlug[clean.slug] = clean;
    }
    return bySlug;
  } catch (err) {
    console.warn('[product_settings] lookup threw:', err.message);
    return {};
  }
}

module.exports = { COLUMNS, MAX_HANDLING_DAYS, isMissingTable, handlingDays, normalizeRow, fetchSettings };
