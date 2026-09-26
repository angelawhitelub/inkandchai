/**
 * Pure helpers for Ink AI star ratings, kept apart from the handler so they
 * can be tested without Supabase.
 */

const MAX_COMMENT = 1000;

/**
 * Validate what the widget posted. Returns { row } or { error }.
 *
 * The body is anonymous and customer-controlled, so everything is clipped and
 * the rating must be a whole number 1-5 -- "4.5", "5 stars", 0 and 6 are all
 * refused rather than rounded, because a rounded rating is one nobody gave.
 */
function parseFeedback(body) {
  const b = body && typeof body === 'object' ? body : {};
  const session = String(b.session_id || '').trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(session)) return { error: 'session_id required' };

  const rating = typeof b.rating === 'number' ? b.rating : Number.NaN;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { error: 'rating must be 1-5' };

  const comment = String(b.comment == null ? '' : b.comment).replace(/\s+$/g, '').slice(0, MAX_COMMENT).trim();
  const page = String(b.page_url || '').slice(0, 300);
  const turns = Number.isInteger(b.turns) && b.turns >= 0 ? Math.min(b.turns, 500) : null;

  return {
    row: {
      session_id: session,
      rating,
      comment: comment || null,
      // Only our own paths: a full URL or anything else is dropped, not stored.
      page_url: page.startsWith('/') ? page : null,
      turns,
      updated_at: new Date().toISOString(),
    },
  };
}

/** { count, average, distribution: {1..5} } from a list of ratings. */
function summarise(ratings) {
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  let count = 0;
  for (const r of ratings || []) {
    if (!Number.isInteger(r) || r < 1 || r > 5) continue;
    distribution[r] += 1;
    sum += r;
    count += 1;
  }
  return { count, average: count ? Math.round((sum / count) * 100) / 100 : null, distribution };
}

module.exports = { parseFeedback, summarise, MAX_COMMENT };
