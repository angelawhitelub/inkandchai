/**
 * The "split" banner layout: a quiet paper half carrying the words, and a
 * saturated panel carrying the books.
 *
 * WHY THIS ONE CARRIES ITS OWN CSS
 * --------------------------------
 * The homepage injects a published slide by setting innerHTML on a holder and
 * lifting out the .promo-slide element -- anything beside it is dropped. So the
 * <style> lives INSIDE the section. That has two consequences worth keeping:
 * publishing a banner in a layout the build has never seen needs no deploy, and
 * the admin preview shows the real thing rather than an approximation of it.
 *
 * Colours come in as CSS variables from a palette ID, so one stylesheet covers
 * every colour way and the model never names a colour.
 */

'use strict';

const { palette } = require('./banner-palettes');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// The fan behind the featured cover. Hand-placed rather than computed: three
// covers at a readable spread is the most this composition takes before the
// titles start hiding each other.
const FAN = [
  { rot: -7, x: 0, y: 0, z: 3, scale: 1 },
  { rot: 8, x: 26, y: 5, z: 2, scale: 0.86 },
  { rot: -16, x: -28, y: 7, z: 1, scale: 0.82 },
];

const CSS = `
.bnr-sp{padding:0;display:block;background:var(--sp-paper);color:var(--sp-ink);
  font-family:'Inter',system-ui,sans-serif;overflow:hidden}
.bnr-sp *{box-sizing:border-box}
.bnr-sp-wrap{display:grid;grid-template-columns:1fr 1fr;min-height:clamp(340px,42vw,520px)}
.bnr-sp.flip .bnr-sp-paper{order:2}
.bnr-sp-paper{background:var(--sp-paper);color:var(--sp-ink);
  padding:clamp(1.6rem,4vw,3.4rem);display:flex;flex-direction:column;justify-content:center;gap:clamp(.7rem,1.4vw,1.1rem)}
.bnr-sp-eyebrow{font-size:clamp(.54rem,.85vw,.66rem);letter-spacing:.22em;text-transform:uppercase;font-weight:600;color:var(--sp-ink);opacity:.85}
.bnr-sp-title{font-family:'Cormorant Garamond','DM Serif Display',Georgia,serif;font-weight:600;
  font-size:clamp(1.9rem,4.4vw,3.5rem);line-height:1.04;letter-spacing:-.01em;margin:0;color:var(--sp-ink)}
.bnr-sp-title em{font-style:italic;color:var(--sp-panel);font-weight:600}
.bnr-sp-sub{font-size:clamp(.72rem,1.1vw,.92rem);line-height:1.7;color:var(--sp-muted);margin:0;max-width:34ch}
.bnr-sp-cta{align-self:flex-start;display:inline-flex;align-items:center;gap:1.4rem;
  background:var(--sp-btn);color:var(--sp-btn-ink);text-decoration:none;border-radius:999px;
  padding:clamp(.7rem,1.3vw,1rem) clamp(1.1rem,2vw,1.7rem);font-size:clamp(.7rem,1vw,.85rem);
  font-weight:500;transition:transform .2s ease,opacity .2s ease}
.bnr-sp-cta:hover{transform:translateY(-2px);opacity:.92}
.bnr-sp-cta span{font-size:1.05em;line-height:1}
.bnr-sp-foot{font-size:clamp(.58rem,.85vw,.7rem);color:var(--sp-muted);letter-spacing:.02em}
.bnr-sp-panel{background:var(--sp-panel);color:var(--sp-panel-ink);position:relative;
  padding:clamp(1.2rem,2.4vw,2rem);display:flex;flex-direction:column;align-items:center;gap:.6rem}
.bnr-sp-plabel,.bnr-sp-plink{font-size:clamp(.52rem,.8vw,.64rem);letter-spacing:.22em;text-transform:uppercase;
  font-weight:600;color:var(--sp-panel-ink);text-decoration:none;text-align:center}
.bnr-sp-plink:hover{opacity:.8}
.bnr-sp-stage{flex:1;width:100%;position:relative;display:flex;align-items:center;justify-content:center;
  min-height:clamp(200px,26vw,340px)}
.bnr-sp-ring{position:absolute;width:min(70%,24vw,290px);aspect-ratio:1;border-radius:50%;
  border:1px solid var(--sp-panel-soft);pointer-events:none}
.bnr-sp-cover{position:absolute;display:block;text-decoration:none;transition:transform .35s ease}
.bnr-sp-cover img{display:block;width:clamp(112px,15vw,196px);height:auto;
  box-shadow:0 22px 48px rgba(0,0,0,.32);background:var(--sp-panel-soft)}
.bnr-sp-cover:hover{transform:translateY(-6px) rotate(0deg)!important}
.bnr-sp-sticker{position:absolute;right:2%;bottom:4%;width:clamp(74px,9vw,124px);aspect-ratio:1;border-radius:50%;
  background:var(--sp-sticker);color:var(--sp-sticker-ink);display:flex;flex-direction:column;
  align-items:center;justify-content:center;text-align:center;transform:rotate(-8deg);
  font-family:'Cormorant Garamond',Georgia,serif;font-size:clamp(.72rem,1.1vw,1.02rem);line-height:1.2;
  font-style:italic;padding:.4rem;box-shadow:0 10px 26px rgba(0,0,0,.2)}
@media(max-width:760px){
  .bnr-sp-wrap{grid-template-columns:1fr;min-height:0}
  .bnr-sp.flip .bnr-sp-paper{order:0}
  .bnr-sp-paper{padding:1.6rem 1.2rem;gap:.7rem}
  .bnr-sp-panel{padding:1.1rem 1rem 1.4rem}
  .bnr-sp-stage{min-height:230px}
  .bnr-sp-ring{width:min(62%,210px)}
  .bnr-sp-sticker{right:4%;bottom:2%}
  .bnr-sp-sub{max-width:none}
}
@media(prefers-reduced-motion:reduce){.bnr-sp-cta,.bnr-sp-cover{transition:none}}
`.replace(/\n\s*/g, '');

/**
 * @param f      text fields (already escaped here, never trusted)
 * @param books  [{slug,title,img}] in the admin's chosen order
 */
function renderSplit(f, books) {
  const p = palette(f.palette);
  const list = (Array.isArray(books) ? books : []).slice(0, FAN.length);

  const covers = list.map((b, i) => {
    const s = FAN[i] || FAN[0];
    const t = `translate(${s.x}px, ${s.y}px) rotate(${s.rot}deg) scale(${s.scale})`;
    return `<a class="bnr-sp-cover" style="transform:${t};z-index:${s.z};" `
      + `href="/product/${encodeURIComponent(b.slug)}/">`
      + `<img src="${esc(b.img)}" alt="${esc(b.title)}" loading="lazy"/></a>`;
  }).join('');

  // Every one of these has a fallback: a banner drafted before these fields
  // existed, or re-rendered into this layout from another, still comes out
  // whole rather than with holes where the new copy would go.
  const eyebrow = esc(f.eyebrow || 'The Ink & Chai reading room');
  const line1 = esc(f.title_line1 || '');
  const line3 = esc(f.title_line3 || '');
  const accent = esc(f.title_accent || '');
  // The accent closes the sentence here rather than sitting on its own line --
  // that inline italic at the end is what gives this layout its voice.
  const title = [line1, [line3, accent && `<em>${accent}</em>`].filter(Boolean).join(' ')]
    .filter(Boolean).join('<br/>');

  const sticker = [f.sticker_line1, f.sticker_line2].map(x => esc(x)).filter(Boolean);
  const style = `--sp-paper:${p.paper};--sp-ink:${p.ink};--sp-muted:${p.muted};`
    + `--sp-panel:${p.panel};--sp-panel-ink:${p.panelInk};--sp-panel-soft:${p.panelSoft};`
    + `--sp-sticker:${p.sticker};--sp-sticker-ink:${p.stickerInk};`
    + `--sp-btn:${p.btn};--sp-btn-ink:${p.btnInk};`;

  return `  <!-- Banner: ${eyebrow} (split) -->
  <section class="hero promo-slide bnr-sp${f.flip ? ' flip' : ''}" style="${style}" aria-label="${eyebrow}">
    <style>${CSS}</style>
    <div class="bnr-sp-wrap">
      <div class="bnr-sp-paper">
        <div class="bnr-sp-eyebrow">${eyebrow}</div>
        <h2 class="bnr-sp-title">${title}</h2>
        ${f.subtitle ? `<p class="bnr-sp-sub">${esc(f.subtitle)}</p>` : ''}
        <a class="bnr-sp-cta" href="${esc(f.cta_href || '/bestsellers/')}">${esc(f.cta_label || 'Shop now')}<span>&#8599;</span></a>
        ${f.footnote ? `<div class="bnr-sp-foot">${esc(f.footnote)}</div>` : ''}
      </div>
      <div class="bnr-sp-panel">
        <div class="bnr-sp-plabel">${esc(f.panel_eyebrow || f.cta_secondary || 'One more chapter')}</div>
        <div class="bnr-sp-stage">
          <span class="bnr-sp-ring"></span>
          ${covers}
          ${sticker.length ? `<span class="bnr-sp-sticker">${sticker.map(x => `<span>${x}</span>`).join('')}</span>` : ''}
        </div>
        <a class="bnr-sp-plink" href="${esc(f.cta_secondary_href || '/bestsellers/')}">${esc(f.cta_secondary || 'Browse all books')} &#8599;</a>
      </div>
    </div>
  </section>`;
}

module.exports = { renderSplit, esc, _internals: { FAN, CSS } };
