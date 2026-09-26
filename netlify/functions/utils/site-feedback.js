/**
 * Pure helpers for customer feedback on the website and on ordering, kept
 * apart from the handler so they can be tested without Supabase.
 *
 * Two kinds:
 *   website -- a browsing visitor rating the site itself. Keyed by a random
 *              id the browser keeps, so rating again updates the same row.
 *   order   -- a customer rating the ordering experience on the confirmation
 *              screen. Keyed by the order id, one rating per order.
 */

const MAX_COMMENT = 1000;
const KINDS = ['website', 'order'];

/**
 * Validate what the page posted. Returns { row } or { error }.
 *
 * The body is anonymous and customer-controlled, so everything is clipped and
 * the rating must be a whole number 1-5 -- "4.5", "5 stars", 0 and 6 are all
 * refused rather than rounded, because a rounded rating is one nobody gave.
 */
function parseFeedback(body) {
  const b = body && typeof body === 'object' ? body : {};
  const kind = String(b.kind || '');
  if (!KINDS.includes(kind)) return { error: 'kind must be website or order' };

  const rating = typeof b.rating === 'number' ? b.rating : Number.NaN;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { error: 'rating must be 1-5' };

  const visitor = String(b.visitor_id || '').trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(visitor)) return { error: 'visitor_id required' };

  let orderId = null;
  if (kind === 'order') {
    orderId = String(b.order_id || '').trim();
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(orderId)) return { error: 'order_id required' };
  }

  const comment = String(b.comment == null ? '' : b.comment).slice(0, MAX_COMMENT).trim();
  const page = String(b.page_url || '').slice(0, 300);
  const device = ['mobile', 'desktop'].includes(b.device) ? b.device : null;

  return {
    row: {
      feedback_key: kind === 'order' ? `order:${orderId}` : `web:${visitor}`,
      kind,
      rating,
      comment: comment || null,
      order_id: orderId,
      visitor_id: visitor,
      // Only our own paths: a full URL or anything else is dropped, not stored.
      page_url: page.startsWith('/') ? page : null,
      device,
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

module.exports = { parseFeedback, summarise, MAX_COMMENT, KINDS };
