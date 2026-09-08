/**
 * Turn a set of banner text fields plus real book rows into a homepage slide.
 *
 * Shared by generate-banner-copy (the admin drafts one) and site-banners (the
 * homepage renders the published ones). It lives here rather than inside the
 * admin function because the PUBLIC endpoint must render too, and a public
 * endpoint reaching into an admin function's internals is the kind of coupling
 * that quietly breaks.
 *
 * WHY THE HTML IS NOT STORED
 * --------------------------
 * A published banner is stored as fields + book slugs, never as markup, and it
 * is re-rendered through here on every read. So escaping is applied at render
 * time, every time: a row in the database is inert text, not something that
 * gets injected into the homepage as-is. It also means a book whose cover or
 * title changed shows the new one without republishing.
 */

'use strict';

// Every value below is inserted as TEXT. Escaping here, rather than trusting
// whatever produced the fields, is what makes this safe to put on the homepage.
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Assemble the slide. Every value here is either escaped model text or DB data. */
function renderSlide(f, books) {
  const covers = books.map((b, i) => `
          <a class="hero-cover-card${i === 0 ? ' featured' : ''}" href="/product/${encodeURIComponent(b.slug)}/" data-label="${esc(b.title.slice(0, 40))}">
            <picture><img src="${esc(b.img)}" alt="${esc(b.title)}" loading="lazy"/></picture>
          </a>`).join('');

  const stats = (f.stats || []).slice(0, 3).map(s => `
        <div><div class="stat-num">${esc(s.num)}</div><div class="stat-label">${esc(s.label)}</div></div>`).join('');

  return `  <!-- Banner: ${esc(f.eyebrow)} -->
  <section class="hero promo-slide" style="padding:0;" aria-label="${esc(f.eyebrow)}">
    <div class="hero-left">
      <div class="hero-eyebrow">${esc(f.eyebrow)}</div>
      <h2 class="hero-title">${esc(f.title_line1)}<br/><em>${esc(f.title_accent)}</em><br/>${esc(f.title_line3)}</h2>
      <p class="hero-sub hero-sub-desktop">${esc(f.subtitle)}</p>
      <div class="hero-ctas">
        <a href="${esc(f.cta_href)}" class="btn-primary">${esc(f.cta_label)}${f.price_label ? ` — ${esc(f.price_label)}` : ''}</a>
        <a href="${esc(f.cta_secondary_href)}" class="btn-ghost">${esc(f.cta_secondary)}</a>
      </div>
      <div class="hero-stats">${stats}
      </div>
    </div>
    <div class="hero-right">
      <div class="hero-cover-wall" aria-label="${esc(f.eyebrow)} featured books">${covers}
      </div>
    </div>
  </section>`;
}

module.exports = { renderSlide, esc };
