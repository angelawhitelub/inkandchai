/**
 * The "Only 4 left" urgency badge (admin Products → "Scarcity badge").
 *
 * The admin tick is saved on product_overrides.scarcity, but product pages are
 * baked: only the books pinned in generate_site.py SCARCITY_SLUGS carried the
 * badge, and the page's own override script never read the flag, so ticking
 * or unticking a book changed nothing (30 Oct 2026). The Worker now applies
 * the list built here to every product page, baked or admin-created.
 *
 * A book shows the badge when its active override says so, or when it is
 * pinned and no active override says otherwise.
 */

// Mirrors generate_site.py SCARCITY_SLUGS: the books baked with the badge.
const PINNED_SCARCE = [
  'off-campus-complete-5-book-collection-elle-kennedy',
  'the-deal-the-mistake-the-score-elle-kennedy-off-campus-combo',
  'the-off-campus-series-complete-collection-5-books-by-elle-ke-nnedy',
  'the-deal-the-mistake-the-score-by-elle-kennedy-off-campus-se--3-ek',
  'colleen-hoover-3-book-starter-set-it-ends-with-us-verity-rem-ter-3',
  'wealth-starter-pack-299-psychology-of-money-rich-dad-poor-da-k-299',
  'hindi-motivation-big-4-atomic-habits-rich-dad-poor-dad-shakt-big-4',
  'robert-greene-power-trilogy-48-laws-of-power-laws-of-human-n-ogy-3',
];

/** Set of lower-cased slugs that show the badge. Throws on a database error. */
async function scarceSlugs(db) {
  const on = await db.from('product_overrides').select('slug,is_active').eq('scarcity', true);
  if (on.error) throw new Error(on.error.message);
  const pinned = await db.from('product_overrides').select('slug,scarcity,is_active').in('slug', PINNED_SCARCE);
  if (pinned.error) throw new Error(pinned.error.message);
  const out = new Set();
  const turnedOff = new Set((pinned.data || [])
    .filter((r) => r.is_active !== false && r.scarcity === false)
    .map((r) => String(r.slug || '').toLowerCase()));
  for (const s of PINNED_SCARCE) if (!turnedOff.has(s)) out.add(s);
  for (const r of on.data || []) {
    if (r.is_active !== false && r.slug) out.add(String(r.slug).toLowerCase());
  }
  return out;
}

// Same look as the baked badge (generate_site.py scarcity_badge_html).
const BADGE_HTML = '<div class="prod-scarcity" style="display:inline-flex;align-items:center;gap:0.5rem;'
  + 'margin:0.6rem 0 0.2rem;padding:0.45rem 0.85rem;background:rgba(220,60,40,0.1);'
  + 'border:1px solid rgba(220,60,40,0.3);border-radius:2px;font-size:0.73rem;color:#f07060;">'
  + '<span style="width:7px;height:7px;border-radius:50%;background:#e05040;'
  + 'box-shadow:0 0 0 3px rgba(220,60,40,0.25);display:inline-block;flex-shrink:0;"></span>'
  + '🔥 Hurry! Only <strong>&nbsp;4 left</strong>&nbsp;in stock</div>';

module.exports = { PINNED_SCARCE, scarceSlugs, BADGE_HTML };
