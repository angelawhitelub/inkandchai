const { createClient } = require('@supabase/supabase-js');
const SOCIAL_PROOF = require('../../data/social_proof.json').items || [];
const { richText, plainText } = require('./utils/rich-text');

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function moneyText(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `₹ ${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '';
}

function shortDescription(product) {
  const fallback = `Buy ${product.title} online at Ink & Chai. Fast pan-India delivery, secure checkout, COD and prepaid payment available.`;
  // plainText strips the markdown marks — a meta description reading
  // "**Bold** and *italic*" would show the asterisks verbatim in Google.
  return plainText(product.meta_description || product.description || fallback).slice(0, 160);
}

// Declared up here because proxifySupabaseImage needs it — see the fuller note
// on the video-slide convention further down.
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(?=$|[?#])/i;

// Route Supabase Storage image URLs through our Netlify image proxy so
// Supabase egress isn't hit every time a crawler / Google Merchant / visitor
// loads a product page. Anything else (local /images, external CDNs) is left
// untouched. See netlify/functions/img-proxy.js for the cache policy.
function proxifySupabaseImage(url) {
  try {
    // /spimg/ routes to the image proxy, which cannot serve a video — an .mp4
    // sent through it fails. A gallery video hosted on Supabase (the fallback
    // when R2 is unconfigured) must be linked directly. R2 URLs are a different
    // host and already fall through untouched below.
    if (VIDEO_EXT.test(String(url || ''))) return url;
    const supaHost = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).host : null;
    if (!supaHost) return url;
    const u = new URL(url);
    if (u.host !== supaHost) return url;
    if (!u.pathname.startsWith('/storage/v1/object/public/')) return url;
    const key = u.pathname.replace('/storage/v1/object/public/', '');
    return `https://inkandchai.in/spimg/${key}`;
  } catch { return url; }
}

function absoluteImage(url) {
  const image = String(url || '/images/og-default.jpg');
  if (image.startsWith('data:')) return image;
  if (image.startsWith('http')) return proxifySupabaseImage(image);
  return `https://inkandchai.in${image.startsWith('/') ? image : `/${image}`}`;
}

// Route same-site images through Netlify Image CDN so covers are resized and
// served as webp instead of the full-resolution original. Cuts image bandwidth
// ~70-85% for on-page covers and social preview cards. Only transforms assets
// we serve ourselves (/images, /spimg); data:, external CDNs, and the legacy
// image-proxy are left untouched. `absolute` returns a full URL (for og:image).
function cdnImage(url, width, absolute = false) {
  const raw = String(url || '');
  if (!raw || raw.startsWith('data:')) return raw;
  let path = raw.replace(/^https?:\/\/inkandchai\.in/i, '');
  if (!(path.startsWith('/images/') || path.startsWith('/spimg/'))) return raw;
  const t = `/.netlify/images?url=${encodeURIComponent(path)}&w=${width}&fm=webp&q=72`;
  return absolute ? `https://inkandchai.in${t}` : t;
}

// ── Video "quality proof" slides ──────────────────────────────────────────────
// A gallery entry that points at a video file becomes a playable slide instead
// of an <img>. This is how we show the ACTUAL book — paper, print, binding —
// rather than only the publisher's cover render.
//
// Convention (no schema change, no migration): any gallery_images entry ending
// in .mp4/.webm/.mov/.m4v is a video. Its poster frame is the same URL with the
// extension swapped for "-poster.webp", uploaded alongside it by the admin
// panel's video uploader (netlify/functions/upload-product-video.js) or by
// scripts/upload-product-video-r2.mjs. Videos MUST be hosted on R2
// (pub-….r2.dev) — Cloudflare charges zero egress, so an 8 MB clip costs
// nothing, whereas the same file on Netlify or Supabase would eat the bandwidth
// quota in a day.
//
// VIDEO_EXT itself is declared near the top of the file, because
// proxifySupabaseImage has to consult it before rewriting anything.
function isVideoUrl(url) { return VIDEO_EXT.test(String(url || '')); }
function posterForVideo(url) { return String(url || '').replace(VIDEO_EXT, '-poster.webp'); }

// ── Tracking tags ────────────────────────────────────────────────────────────
// These pages carried NO Meta Pixel and NO Google tag at all. They serve any
// product not yet in the static build — i.e. a listing created in the admin
// panel between deploys, which is exactly when a new book is most likely to be
// advertised. Views on it were invisible to both platforms.
//
// Kept byte-identical to META_PIXEL_CODE / GOOGLE_ADS_TAG in generate_site.py.
// Three copies of the pixel id now exist (there, here, and public/track/), so a
// pixel change has to touch all three — grep the id, don't edit just one.
const META_PIXEL_CODE = `<!-- Meta Pixel Code -->
<script>
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '1702042431242274');
fbq('init', '1639520197322862');
fbq('track', 'PageView');

// Standard-event helper. Lives here because it is the only code guaranteed on
// every page — checkout has its own cart implementation and does not load
// cart.js, so a helper defined there would not exist where Purchase fires.
// fbq('track') reports to every initialised pixel, so one call feeds both.
// dedupKey (optional) makes an event fire once per order however many times the
// success screen is re-rendered or reloaded.
window.iacMeta = function(event, params, dedupKey) {
  if (typeof fbq !== 'function') return;
  if (dedupKey) {
    try { if (localStorage.getItem(dedupKey)) return; } catch (e) {}
  }
  try {
    fbq('track', event, params || {});
    if (dedupKey) localStorage.setItem(dedupKey, '1');
  } catch (e) {}
};
// content_ids for a cart, in the shape Meta matches catalogue items on.
window.iacMetaIds = function(cart) {
  try {
    return (cart || []).map(function(i) {
      return String(i.id || i.url || i.slug || '');
    }).filter(Boolean);
  } catch (e) { return []; }
};
</script>
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id=1702042431242274&ev=PageView&noscript=1"
/></noscript>
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id=1639520197322862&ev=PageView&noscript=1"
/></noscript>
<!-- End Meta Pixel Code -->`;

const GOOGLE_ADS_TAG = `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=AW-18119332653"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'AW-18119332653');
gtag('config', 'AW-18139908537');
</script>
<!-- End Google tag -->`;

// Trust badges. Inline SVG rather than emoji: emoji are drawn by the reader's
// OS, so they differ on every device and cannot take the page's gold. These
// inherit currentColor and stay sharp at any size. Keep in step with the same
// badges in generate_site.py, which renders the statically-built product pages.
const SVG = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICON = {
  truck:  SVG('<path d="M3 7h11v9H3z"/><path d="M14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.8"/><circle cx="17.5" cy="18" r="1.8"/>'),
  cash:   SVG('<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/>'),
  card:   SVG('<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/><path d="M6 14.5h4"/>'),
  shield: SVG('<path d="M12 3l7.5 3v5.5c0 4.3-3.1 7.7-7.5 9-4.4-1.3-7.5-4.7-7.5-9V6z"/><path d="M9 12l2 2 4-4"/>'),
};
function trustBadge(icon, label, sub) {
  return `<span><span class="ti" aria-hidden="true">${icon}</span>`
    + `<span class="tt"><b>${esc(label)}</b><i>${esc(sub)}</i></span></span>`;
}

function applyOverride(product, override) {
  if (!product || !override || override.is_active === false) return product;
  return {
    ...product,
    title: override.title || product.title,
    author: override.author || product.author,
    category: override.category || product.category,
    price_inr: override.price_inr ?? product.price_inr,
    original_price_inr: override.original_price_inr ?? product.original_price_inr,
  };
}

function productHtml(product) {
  const slug = esc(product.slug);
  const title = esc(product.title);
  const author = esc(product.author || 'Ink & Chai');
  const category = esc(product.category || 'Books');
  // Admin copy supports markdown-lite (**bold**, *italic*, ## heading, - list).
  // richText escapes first and only then adds the tags it generates itself, so
  // a plain-text description from before this existed renders unchanged.
  const desc = richText(product.description);
  const authorBio = richText(product.author_bio);
  // Crossword-bestseller import tags products with `publisher-sourced-bestseller`
  // so this Lambda-rendered page can light up the same trust banner the
  // static-rendered catalogue pages already show. GST invoice line is part of
  // the same banner — these orders are eligible for one on request.
  const publisherSourced = /publisher-sourced-bestseller/i.test(String(product.tags || ''));
  // Full crossword.in catalogue import: COD disabled, partial COD (pay 10%)
  // recommended. The flag rides along on the cart item so checkout enforces it.
  const noCod = /(?:^|,)\s*no-cod\s*(?:,|$)/i.test(String(product.tags || ''));
  const metaDesc = esc(shortDescription(product));
  const canonical = `https://inkandchai.in/product/${slug}/`;
  const image = absoluteImage(product.image_url);
  // Extra images (back cover, spreads, etc.) live in gallery_images (jsonb array
  // of URLs). Main cover first, then the rest — de-duped, absolutised.
  let galleryExtra = [];
  try {
    const g = Array.isArray(product.gallery_images) ? product.gallery_images
            : (typeof product.gallery_images === 'string' ? JSON.parse(product.gallery_images) : []);
    galleryExtra = (Array.isArray(g) ? g : []).map(u => absoluteImage(String(u || '').trim())).filter(Boolean);
  } catch { galleryExtra = []; }
  const galleryImgs = [image, ...galleryExtra].filter((v, i, a) => v && a.indexOf(v) === i);
  // Resized/webp versions for on-page display + social preview. `image` (full
  // res) stays as-is for the schema.org/Merchant feed; only the visible <img>
  // and og:image use the CDN-transformed variants. og:image and the schema.org
  // feed always use the main cover, which is never a video — so a quality-proof
  // clip in the gallery can't leak into a Merchant listing.
  const ogImage = cdnImage(image, 800, true);
  // Videos are already served at their final size from R2; only run real images
  // through the Netlify Image CDN (it would 500 on an .mp4 under /spimg/).
  const displayImgs = galleryImgs.map(src => (isVideoUrl(src) ? src : cdnImage(src, 600)));
  const price = moneyText(product.price_inr);
  const mrp = moneyText(product.original_price_inr);
  // Percentage off MRP, shown next to the price. Only when the MRP is genuinely
  // above the sale price, so a missing or mis-keyed MRP can't print "0% off".
  const saleNum = Number(product.price_inr) || 0;
  const mrpNum = Number(product.original_price_inr) || 0;
  const savePct = (mrpNum > saleNum && saleNum > 0) ? Math.round((mrpNum - saleNum) / mrpNum * 100) : 0;
  // schema.org description is ingested by Google Merchant — must be prose, not markdown.
  const plainDesc = plainText(product.description) || metaDesc;

  // Hide browse-only catalogue imports from Google Shopping / free listings.
  // These bulk imports carry a `*-catalog` tag and their cover images are tiny
  // (~50px Goodreads/Amazon thumbnails), which Google Merchant disapproves as
  // "image too small". They exist for on-site search depth, not advertising —
  // so we drop the shopping signals (the Offer + product og:type) while keeping
  // the page fully indexable and buyable on-site. Also catch the obvious tiny
  // image filenames (…_SX50) regardless of tag.
  const browseOnlyCatalog = /(?:^|,)\s*(?:crossword-catalog|99bookstores-catalog|bookstohome-catalog|imported-bookstohome|catalog)\s*(?:,|$)/i.test(String(product.tags || ''));
  const tinyImage = /\._S[XY](?:\d{1,2}|1\d\d)[_.]/.test(String(product.image_url || ''));
  const hideFromGoogleShopping = browseOnlyCatalog || tinyImage;

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Book',
    name: product.title,
    author: { '@type': 'Person', name: product.author || 'Various' },
    image,
    description: plainDesc,
    isbn: product.isbn || undefined,
    publisher: product.publisher || 'Ink & Chai',
    bookFormat: 'https://schema.org/Paperback',
    url: canonical,
    // Only expose an Offer (the shopping signal Google Merchant ingests) for
    // real, advertise-able products — never for browse-only catalogue imports.
    ...(hideFromGoogleShopping ? {} : {
      offers: {
        '@type': 'Offer',
        url: canonical,
        priceCurrency: 'INR',
        price: Number(product.price_inr),
        availability: 'https://schema.org/InStock',
        itemCondition: 'https://schema.org/NewCondition',
        seller: { '@type': 'Organization', name: 'Ink & Chai' },
      },
    }),
  };
  const ogType = hideFromGoogleShopping ? 'book' : 'product';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
${META_PIXEL_CODE}
${GOOGLE_ADS_TAG}
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(product.seo_title || `${product.title} | Buy Online in India | Ink & Chai`)}</title>
<meta name="description" content="${metaDesc}"/>
<meta name="robots" content="index,follow"/>
<link rel="canonical" href="${canonical}"/>
<meta property="og:type" content="${ogType}"/>
<meta property="og:title" content="${title} | Ink & Chai"/>
<meta property="og:description" content="${metaDesc}"/>
<meta property="og:image" content="${esc(ogImage)}"/>
<meta property="og:url" content="${canonical}"/>
<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=Montserrat:wght@300;400;600;700&display=swap" rel="stylesheet"/>
<style>
:root{--bg:#090807;--panel:#15110e;--gold:#d6b85e;--gold-light:#f0d889;--copper:#b8754c;--cream:#f4ecdc;--muted:#b9ab96;--border:rgba(214,184,94,.24);--ink-blue:#182d3b;--glass-bg:rgba(17,15,13,.74);--glass-border:rgba(214,184,94,.28);--glass-shadow:0 18px 60px rgba(0,0,0,.46);--glass-highlight:inset 0 1px rgba(255,255,255,.1)}
html[data-theme="light"]{--bg:#faf7f2;--panel:#fff;--gold:#8a6a1f;--gold-light:#b8902c;--copper:#9b653d;--cream:#2a2018;--muted:#5a4a38;--border:rgba(138,106,31,.28);--ink-blue:#e8edf0;--glass-bg:rgba(250,247,242,.78);--glass-border:rgba(138,106,31,.28);--glass-shadow:0 18px 55px rgba(70,52,24,.12);--glass-highlight:inset 0 1px rgba(255,255,255,.62)}
html:not([data-theme="light"]){color-scheme:dark}
*{box-sizing:border-box} body{margin:0;background:linear-gradient(115deg,rgba(24,45,59,.34) 0%,transparent 30%,transparent 70%,rgba(75,32,38,.24) 100%),linear-gradient(180deg,rgba(214,184,94,.08),transparent 34%,rgba(36,54,47,.14)),repeating-linear-gradient(90deg,rgba(214,184,94,.034) 0 1px,transparent 1px 86px),var(--bg);color:var(--cream);font-family:Montserrat,sans-serif;font-weight:300} a{color:inherit}
html[data-theme="light"] body{background:linear-gradient(115deg,rgba(138,106,31,.08) 0%,transparent 32%,transparent 72%,rgba(138,106,31,.06) 100%),repeating-linear-gradient(90deg,rgba(138,106,31,.03) 0 1px,transparent 1px 86px),var(--bg)}
.promo{width:min(920px,calc(100% - 24px));margin:.7rem auto .2rem;padding:.62rem 1rem;text-align:center;border:1px solid var(--glass-border);border-radius:999px;background:var(--glass-bg);box-shadow:0 10px 28px rgba(0,0,0,.18),var(--glass-highlight);backdrop-filter:blur(18px) saturate(1.2);font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)} .promo strong{color:var(--gold-light)}
html[data-theme="light"] .promo{box-shadow:0 10px 28px rgba(70,52,24,.08),var(--glass-highlight)}
nav{width:min(1180px,calc(100% - 28px));margin:.75rem auto 0;display:flex;align-items:center;justify-content:space-between;padding:1rem clamp(1rem,4vw,4rem);border:1px solid var(--glass-border);border-radius:999px;background:var(--glass-bg);box-shadow:var(--glass-shadow),var(--glass-highlight);backdrop-filter:blur(24px) saturate(1.25);position:sticky;top:12px;z-index:5}.logo{font-family:"Cormorant Garamond",serif;font-size:1.5rem;color:var(--gold-light);text-decoration:none}.back{font-size:.62rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);text-decoration:none}
.wrap{max-width:1260px;margin:0 auto;padding:clamp(1.2rem,4vw,4rem) 1rem 4rem;display:grid;grid-template-columns:minmax(320px,.95fr) 1.05fr;gap:clamp(1.4rem,4vw,4rem);align-items:start}.cover{background:rgba(255,255,255,.055);border:1px solid var(--glass-border);border-radius:28px;padding:clamp(1rem,2.5vw,1.8rem);display:flex;align-items:center;justify-content:center;box-shadow:0 24px 70px rgba(0,0,0,.3),var(--glass-highlight);backdrop-filter:blur(18px) saturate(1.12)}html[data-theme="light"] .cover{background:rgba(255,255,255,.58);box-shadow:0 24px 70px rgba(70,52,24,.1),var(--glass-highlight)}.cover img{max-width:100%;max-height:600px;object-fit:contain;box-shadow:0 24px 64px rgba(0,0,0,.35)}
.crumb{font-size:.58rem;letter-spacing:.24em;text-transform:uppercase;color:var(--gold);margin-bottom:1rem}h1{font-family:"Cormorant Garamond",serif;font-size:clamp(2rem,5vw,3.4rem);font-weight:400;line-height:1.05;margin:.2rem 0 .6rem}.author{color:var(--muted);letter-spacing:.08em;margin-bottom:1rem}.price{font-family:"Cormorant Garamond",serif;font-size:2.7rem;color:var(--gold);font-weight:600}.orig{color:var(--muted);text-decoration:line-through;margin-left:.8rem}.product-price-row{display:flex;align-items:baseline;flex-wrap:wrap;gap:.55rem}.product-price-row .orig{margin-left:0}.save-badge{font-size:.62rem;letter-spacing:.12em;text-transform:uppercase;font-weight:700;color:#237a3b;background:rgba(35,122,59,.1);border:1px solid rgba(35,122,59,.28);padding:.28rem .6rem;white-space:nowrap}.save-badge[hidden]{display:none}.stock{display:inline-block;margin:1rem 0;color:#237a3b;border:1px solid rgba(35,122,59,.25);padding:.35rem .65rem;font-size:.7rem;letter-spacing:.14em;text-transform:uppercase}
.trust{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.6rem;margin:1.2rem 0}.trust>span{display:flex;align-items:center;gap:.65rem;border:1px solid var(--border);border-radius:14px;background:linear-gradient(180deg,rgba(214,184,94,.09),rgba(214,184,94,.03));padding:.7rem .8rem;color:var(--cream);font-size:.78rem;box-shadow:var(--glass-highlight);transition:border-color .2s ease,transform .2s ease}.trust>span:hover{border-color:rgba(214,184,94,.45);transform:translateY(-1px)}.trust .ti{flex:0 0 auto;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:rgba(214,184,94,.14);color:var(--gold)}.trust .ti svg{width:17px;height:17px;display:block}.trust .tt{min-width:0;display:flex;flex-direction:column;gap:.1rem;line-height:1.25}.trust .tt b{font-weight:600;font-size:.8rem;color:var(--cream)}.trust .tt i{font-style:normal;font-size:.68rem;color:var(--muted)}html[data-theme="light"] .trust>span{background:linear-gradient(180deg,rgba(255,255,255,.7),rgba(255,255,255,.35));box-shadow:inset 0 1px rgba(255,255,255,.5)}.actions{display:grid;grid-template-columns:1fr 1fr;gap:.8rem;margin:1.3rem 0}button{font:700 .68rem Montserrat,sans-serif;letter-spacing:.2em;text-transform:uppercase;padding:1rem;border:1px solid var(--gold);border-radius:999px;cursor:pointer;min-height:52px;transition:transform .2s ease,filter .2s ease,box-shadow .2s ease}button:hover{transform:translateY(-1px);filter:brightness(1.05)}.primary{background:linear-gradient(135deg,var(--gold),var(--copper));color:#100c08;box-shadow:0 14px 30px rgba(214,184,94,.18),var(--glass-highlight)}.secondary{background:rgba(214,184,94,.075);color:var(--gold-light)}
.desc,.details{border-top:1px solid var(--border);border-radius:24px;padding-top:1.2rem;margin-top:1.2rem;color:var(--muted);font-size:.9rem;line-height:1.8;white-space:pre-line}.label{font-size:.58rem;letter-spacing:.26em;text-transform:uppercase;color:var(--gold);margin-bottom:.5rem}.details dl{display:grid;grid-template-columns:120px 1fr;gap:.5rem 1rem}.details dt{color:var(--gold)}.details dd{margin:0;color:var(--cream)}
/* Rich admin copy. pre-line is turned OFF here because richText() emits real
   <p>/<br> blocks — leaving it on would double every line break. */
.rich{white-space:normal}
.rich p{margin:0 0 .85rem}.rich p:last-child{margin-bottom:0}
.rich strong{color:var(--cream);font-weight:700}
.rich em{font-style:italic;color:var(--cream)}
.rich h3{margin:1.15rem 0 .5rem;font-size:.95rem;font-weight:600;color:var(--gold-light);letter-spacing:.01em}
.rich h3:first-of-type{margin-top:0}
.rich ul{margin:0 0 .85rem;padding-left:1.15rem}
.rich li{margin:.3rem 0}
.rich li::marker{color:var(--gold)}
.authorbio p:first-of-type{margin-top:0}
@media(max-width:760px){.promo{width:calc(100% - 20px);margin:.45rem auto .1rem;border-radius:999px;white-space:normal;line-height:1.45}nav{width:calc(100% - 18px);margin:.45rem auto 0;border-radius:28px;padding:.7rem .85rem;top:8px}.wrap{display:block;padding:.9rem 1rem 7.6rem}.cover{margin-bottom:1.2rem;border-radius:24px}.trust{grid-template-columns:repeat(2,minmax(0,1fr));gap:.5rem}.trust>span{padding:.6rem .55rem;gap:.5rem}.trust .ti{width:28px;height:28px}.trust .ti svg{width:15px;height:15px}.trust .tt b{font-size:.73rem}.trust .tt i{font-size:.62rem}.actions{position:fixed;left:12px;right:12px;bottom:10px;z-index:9;margin:0;display:grid;grid-template-columns:1fr 1fr;gap:.6rem;background:rgba(13,11,8,.72);padding:.6rem .6rem calc(.6rem + env(safe-area-inset-bottom));border:1px solid var(--glass-border);border-radius:30px;box-shadow:0 -16px 42px rgba(0,0,0,.45),var(--glass-highlight);backdrop-filter:blur(24px) saturate(1.35)}html[data-theme="light"] .actions{background:rgba(250,247,242,.76);box-shadow:0 -12px 38px rgba(70,52,24,.16),var(--glass-highlight)}.actions button{min-height:52px;padding:.9rem .45rem;font-size:.6rem;letter-spacing:.14em}}
/* Swipeable image gallery (front + back cover etc.) */
.gallery{position:relative;width:100%}
.gallery-track{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;-webkit-overflow-scrolling:touch;border-radius:16px}
.gallery-track::-webkit-scrollbar{display:none}
.gallery-slide{flex:0 0 100%;scroll-snap-align:center;display:flex;align-items:center;justify-content:center}
.gallery-slide img{max-width:100%;max-height:600px;object-fit:contain;box-shadow:0 24px 64px rgba(0,0,0,.35)}
.gal-arrow{position:absolute;top:50%;transform:translateY(-50%);width:42px;height:42px;min-height:42px;border-radius:50%;border:1px solid var(--glass-border);background:var(--glass-bg);color:var(--gold-light);font-size:1.5rem;line-height:1;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2;backdrop-filter:blur(8px);transition:filter .2s}
.gal-arrow:hover{filter:brightness(1.15)}
.gal-prev{left:6px}.gal-next{right:6px}
.gallery-dots{display:flex;gap:.45rem;justify-content:center;margin-top:.9rem}
.gallery-dot{width:9px;height:9px;min-height:9px;border-radius:50%;background:var(--border);border:none;padding:0;cursor:pointer;transition:background .2s,transform .2s}
.gallery-dot.active{background:var(--gold);transform:scale(1.15)}
.gallery-dot.is-video{border:1px solid var(--gold);background:transparent}
.gallery-dot.is-video.active{background:var(--gold)}
/* Video "quality proof" slide — the real book on camera, not a cover render. */
.gallery-slide-video{position:relative}
.gallery-slide-video video{max-width:100%;max-height:600px;border-radius:16px;background:#000;box-shadow:0 24px 64px rgba(0,0,0,.35)}
.vid-badge{position:absolute;top:10px;left:10px;z-index:2;pointer-events:none;font-size:.56rem;letter-spacing:.18em;text-transform:uppercase;color:var(--gold-light);background:rgba(13,11,8,.72);border:1px solid var(--glass-border);border-radius:999px;padding:.32rem .6rem;backdrop-filter:blur(8px)}
@media(max-width:760px){.gal-arrow{display:none}}
/* Nav search — hands the query to the homepage full-catalogue search (/?q=) */
.nav-search{display:flex;align-items:center;gap:.4rem;flex:1;max-width:420px;margin:0 1rem;background:rgba(214,184,94,.07);border:1px solid var(--glass-border);border-radius:999px;padding:.28rem .28rem .28rem .9rem}
.nav-search input{flex:1;background:transparent;border:0;color:var(--cream);font:inherit;font-size:.82rem;outline:none;min-width:0}
.nav-search input::placeholder{color:var(--muted)}
.nav-search button{min-height:0;padding:.45rem .72rem;font-size:1rem;line-height:1;border-radius:999px;border:1px solid var(--glass-border);background:var(--glass-bg);color:var(--gold-light);letter-spacing:0;cursor:pointer}
.nav-search button:hover{filter:brightness(1.12)}
@media(max-width:760px){nav{flex-wrap:wrap} .nav-search{order:3;flex:1 0 100%;max-width:none;margin:.55rem 0 0} .nav-search input{font-size:.95rem} .nav-search button{padding:.5rem .85rem}}
</style>
</head>
<body>
<div class="promo"><strong>Free delivery on ₹499+</strong> · Prepaid offers available · COD available</div>
<nav><a class="logo" href="/">Ink &amp; Chai</a><form class="nav-search" action="/" method="get" role="search"><input type="search" name="q" placeholder="Search books&hellip;" aria-label="Search books" autocomplete="off"/><button type="submit" aria-label="Search">&#128269;</button></form><a class="back" href="/books/">All Books</a></nav>
<main class="wrap">
  <section class="cover">${galleryImgs.length > 1 ? `<div class="gallery">
      <div class="gallery-track" id="galTrack">
        ${displayImgs.map((src, i) => (isVideoUrl(src)
          ? `<div class="gallery-slide gallery-slide-video"><video src="${esc(src)}" poster="${esc(posterForVideo(src))}" controls playsinline muted loop preload="metadata" aria-label="${title} — video of the actual book"></video><span class="vid-badge">&#9654; Real book &middot; video</span></div>`
          : `<div class="gallery-slide"><img src="${esc(src)}" alt="${title} ${i === 0 ? 'front cover' : 'cover view ' + (i + 1)}" loading="${i === 0 ? 'eager' : 'lazy'}"${i === 0 ? ' fetchpriority="high"' : ''} onerror="this.onerror=null;this.src='${esc(galleryImgs[i] || image)}'"/></div>`)).join('')}
      </div>
      <button class="gal-arrow gal-prev" id="galPrev" type="button" aria-label="Previous image">&#8249;</button>
      <button class="gal-arrow gal-next" id="galNext" type="button" aria-label="Next image">&#8250;</button>
      <div class="gallery-dots">${displayImgs.map((src, i) => `<button class="gallery-dot${i === 0 ? ' active' : ''}${isVideoUrl(src) ? ' is-video' : ''}" type="button" aria-label="${isVideoUrl(src) ? 'Show video of the real book' : `Show image ${i + 1}`}"></button>`).join('')}</div>
    </div>` : `<img src="${esc(displayImgs[0] || image)}" alt="${title} book cover" loading="eager" fetchpriority="high" onerror="this.onerror=null;this.src='${esc(image)}'"/>`}</section>
  <section>
    <div class="crumb"><a href="/">Home</a> / <a href="/category/?name=${encodeURIComponent(product.category || 'Books')}">${category}</a></div>
    <h1>${title}</h1>
    <div class="author">by ${author}</div>
    <div class="product-price-row" data-sale-anchor><span class="price" data-product-price="${saleNum}">${esc(price)}</span>${mrp ? `<span class="orig" data-product-original-price="${mrpNum}">${esc(mrp)}</span>` : ''}${savePct ? `<span class="save-badge" data-save-badge>${savePct}% off</span>` : '<span class="save-badge" data-save-badge hidden></span>'}</div>
    <span class="stock">In Stock</span>
    <div class="trust">${trustBadge(ICON.truck, 'Delivery in 2-5 days', 'Shipped across India')}${noCod
      ? trustBadge(ICON.cash, 'Partial COD', 'Pay 10% now, rest on delivery')
      : trustBadge(ICON.cash, 'Cash on delivery', 'Pay when it arrives')}${trustBadge(ICON.card, 'UPI, cards, net banking', 'Secure checkout')}${trustBadge(ICON.shield, '7-day replacement', 'Damaged or wrong book')}</div>
    ${noCod ? `
    <div style="border:1px solid rgba(214,184,94,0.4);background:rgba(214,184,94,0.07);padding:0.85rem 1.05rem;border-radius:14px;margin:0.9rem 0;font-size:0.76rem;color:var(--cream);line-height:1.6;">
      <strong style="color:var(--gold-light);">Cash on Delivery isn't available on this title.</strong>
      We recommend <strong>Partial COD</strong> — pay just <strong>10% now</strong> to confirm your order and the balance on delivery. Full prepaid (UPI/cards) also works.
    </div>` : ''}
    ${publisherSourced ? `
    <div style="border:1px solid rgba(110,170,110,0.4);background:linear-gradient(135deg,rgba(110,170,110,0.12),rgba(214,184,94,0.06));padding:0.95rem 1.1rem;border-radius:14px;margin:1rem 0;display:flex;gap:0.85rem;align-items:flex-start;">
      <div style="font-size:1.5rem;line-height:1;">📚</div>
      <div>
        <div style="font-size:0.58rem;letter-spacing:0.26em;text-transform:uppercase;color:#6daa6d;margin-bottom:0.4rem;font-weight:700;">Genuine — Publisher Sourced</div>
        <div style="font-size:0.78rem;color:var(--cream);line-height:1.65;">Original copy sourced <strong>directly from the publisher's authorised channel</strong>. MRP printed on the back, flat 22.5% off — no piracy, no third-party resellers.</div>
        <div style="font-size:0.72rem;color:var(--muted);line-height:1.65;margin-top:0.45rem;"><strong style="color:var(--gold-light);">🧾 GST invoice available</strong> on request — reply to your order confirmation email with your GSTIN.</div>
      </div>
    </div>` : ''}
    <div class="actions">
      <button class="secondary" id="addToCartBtn" onclick="addProductToCart(false)">Add to Cart</button>
      <button class="primary" onclick="addProductToCart(true)">Buy Now</button>
    </div>
    <!-- Confirmation banner shown after Add to Cart — fills the gap left by the
         absent cart sidebar on this minimalist Lambda-rendered page so the
         customer actually sees that the click worked. -->
    <div id="addedBanner" style="display:none;margin-top:0.9rem;padding:0.85rem 1rem;border:1px solid rgba(109,191,109,0.5);background:rgba(109,191,109,0.08);border-radius:14px;color:#6dbf6d;font-size:0.78rem;line-height:1.55;text-align:center;">
      ✓ Added to cart.
      <a href="/checkout/" style="display:inline-block;margin-left:0.6rem;padding:0.45rem 1rem;background:#6dbf6d;color:#0d0b08;text-decoration:none;font-weight:600;font-size:0.7rem;letter-spacing:0.16em;text-transform:uppercase;">Checkout →</a>
    </div>
    <div class="desc rich"><div class="label">About this book</div>${desc}</div>
    ${authorBio ? `<div class="desc rich authorbio"><div class="label">About the author</div>${authorBio}</div>` : ''}
    <div class="details"><div class="label">Details</div><dl><dt>Format</dt><dd>Paperback</dd><dt>Category</dt><dd>${category}</dd><dt>Publisher</dt><dd>${esc(product.publisher || 'Ink & Chai')}</dd><dt>ISBN</dt><dd>${esc(product.isbn || 'Available on request')}</dd><dt>Sold by</dt><dd>Ink &amp; Chai</dd></dl></div>
  </section>
</main>
<section data-iac-aplus hidden></section>
<section id="bookstagramContent"></section>
<script>window.__IAC_REELS__=${JSON.stringify(SOCIAL_PROOF).replace(/</g, '\\u003c')};</script>
<script src="/js/reels.js" defer></script>
<script src="/js/cart.js"></script>
<!-- Google automated discounts: this page is rendered live, not prerendered by
     generate_site.py, so it needs the include of its own. -->
<script src="/js/google-discount.js"></script>
<script src="/js/search-suggest.js" defer></script>
<script>
const currentItem = ${JSON.stringify({
    id: `/product/${product.slug}/`,
    url: `/product/${product.slug}/`,
    title: product.title,
    author: product.author || '',
    price: Number(product.price_inr),
    img: product.image_url || '',
    qty: 1,
    // Checkout reads these to disable COD + flag genuine sourcing.
    ...(noCod ? { _no_cod: true } : {}),
    ...(publisherSourced ? { _publisher_sourced: true } : {}),
  }).replace(/</g, '\\u003c')};
// ViewContent. content_ids uses currentItem.id — the same value that goes into
// the cart and therefore into AddToCart and Purchase — so Meta sees one
// consistent identifier for the product across the whole funnel.
if (window.iacMeta) {
  window.iacMeta('ViewContent', {
    content_ids: [String(currentItem.id)],
    content_type: 'product',
    content_name: String(currentItem.title || ''),
    currency: 'INR',
    value: Number(currentItem.price) || 0,
  });
}
// Write directly to localStorage so the cart is saved EVEN IF cart.js's
// UI helpers throw on missing sidebar DOM elements (this Lambda page is
// intentionally minimalist and has no cart sidebar). Previously cart.js
// would save the row, then openCart() / updateCartUI() crashed silently,
// the customer saw no feedback, clicked again, eventually gave up — they
// thought add-to-cart was broken.
function addProductToCart(buyNow) {
  try { localStorage.removeItem('iac_buy_now_cart'); } catch(e) {}
  if (buyNow) {
    try { localStorage.setItem('iac_buy_now_cart', JSON.stringify([{ ...currentItem, qty: 1 }])); } catch(e) {}
    location.href = '/checkout/?buynow=1';
    return;
  }
  // Append to akshar_cart (the key checkout / cart.js both read).
  const CART_KEY = 'akshar_cart';
  let cart = [];
  try { cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch(e) { cart = []; }
  if (!Array.isArray(cart)) cart = [];
  const existing = cart.find(function(i){ return i && i.id === currentItem.id; });
  if (existing) existing.qty = (Number(existing.qty) || 1) + 1;
  else cart.push({ ...currentItem, qty: 1 });
  try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); }
  catch(e) {
    alert('Could not add to cart — your browser may be blocking storage. Try the regular Chrome/Safari browser instead of the in-app one.');
    return;
  }
  // Visual confirmation that ALWAYS shows (replaces the missing sidebar).
  const banner = document.getElementById('addedBanner');
  if (banner) banner.style.display = '';
  const btn = document.getElementById('addToCartBtn');
  if (btn) {
    btn.textContent = '✓ In cart — Add another?';
    btn.style.color = '#6dbf6d';
    btn.style.borderColor = '#6dbf6d';
  }
  // Refresh the cart.js sidebar/badge — but do NOT call window.addToCart here.
  // cart.js reads the same 'akshar_cart' key this function just wrote, so
  // addToCart() found the item already present and incremented it again: one
  // click on Add to Cart put TWO copies in the basket. updateCartUI only redraws.
  if (window.updateCartUI) { try { window.updateCartUI(); } catch(e) {} }
  // Meta AddToCart, fired here because cart.js's copy is no longer reached.
  if (window.iacMeta) {
    window.iacMeta('AddToCart', {
      content_ids: [String(currentItem.id || '')],
      content_type: 'product',
      content_name: String(currentItem.title || ''),
      currency: 'INR',
      value: Number(currentItem.price) || 0,
    });
  }
}
// ── Swipeable image gallery: native scroll-snap swipe + arrows + dots ──────────
(function(){
  var track = document.getElementById('galTrack');
  if (!track) return;
  var slides = track.children.length;
  var dots = [].slice.call(document.querySelectorAll('.gallery-dot'));
  // Swiping away from the quality-proof clip stops it — otherwise it keeps
  // playing behind a slide nobody is looking at. Measured geometrically rather
  // than from the rounded scroll index: that index flips to the new slide only
  // at the very END of a smooth scroll, so an index check would pause a video
  // the customer had just tapped play on. Overlap is continuous and exact — a
  // fully visible video is never touched.
  var vids = [].slice.call(track.querySelectorAll('video'));
  function pauseOffscreenVideos(){
    if (!vids.length) return;
    var box = track.getBoundingClientRect();
    vids.forEach(function(v){
      if (v.paused) return;
      var r = v.getBoundingClientRect();
      var visible = Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left));
      if (!r.width || visible / r.width < 0.5) v.pause();
    });
  }
  function current(){ return track.clientWidth ? Math.round(track.scrollLeft / track.clientWidth) : 0; }
  function update(){
    var c = current();
    dots.forEach(function(d,i){ d.classList.toggle('active', i === c); });
    pauseOffscreenVideos();
  }
  function go(i){ i = Math.max(0, Math.min(slides - 1, i)); track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' }); }
  var raf;
  track.addEventListener('scroll', function(){ if (raf) cancelAnimationFrame(raf); raf = requestAnimationFrame(update); });
  var prev = document.getElementById('galPrev'), next = document.getElementById('galNext');
  if (prev) prev.addEventListener('click', function(){ go(current() - 1); });
  if (next) next.addEventListener('click', function(){ go(current() + 1); });
  dots.forEach(function(d,i){ d.addEventListener('click', function(){ go(i); }); });
})();
</script>
<!-- Runtime-rendered admin listings do not pass through generate_site.py, so
     load the shared campaign enhancer here as well. This keeps new products
     in sync with the sale badge/countdown shown on static catalogue pages. -->
<script src="/js/summer-sale.js" defer></script>
</body>
</html>`;
}

/**
 * A 404 is a promise that the page is gone for good: Google Merchant disapproves
 * the product ("Product page unavailable") and Search drops the URL. On 24 Aug
 * 2026 Supabase was unreachable for eight hours and this function answered 404
 * to every custom-product URL, which disapproved 175 listings that were fine.
 *
 * So a missing row gets 404, and every other failure gets 503 + Retry-After —
 * crawlers back off and retry instead of delisting, and the outage stays an
 * outage rather than turning into a catalogue full of dead products.
 */
class DatabaseDown extends Error {
  constructor(message) { super(message); this.name = 'DatabaseDown'; }
}

const notFound = () => ({
  statusCode: 404,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
  body: '<!doctype html><title>Product not found</title><h1>Product not found</h1><p>This product is not available.</p>',
});

function unavailable(reason) {
  console.error('[product-page] serving 503:', reason);
  return {
    statusCode: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Retry-After': '600',
      'Cache-Control': 'no-store',
    },
    body: '<!doctype html><title>Temporarily unavailable</title><h1>Just a moment</h1>'
        + '<p>We could not load this page right now. Please try again in a few minutes.</p>',
  };
}

exports.handler = async (event) => {
  // Slug comes from the /product/* rewrite (?slug=:splat). Fall back to the
  // request path if the splat wasn't passed, and guard against an empty result
  // (filter(Boolean)[0] was undefined -> crashed on .toLowerCase()).
  let raw = event.queryStringParameters?.slug || '';
  if (!raw) {
    const path = event.path || (event.rawUrl || '').split('?')[0] || '';
    raw = path.replace(/.*\/product\//, '');
  }
  const slug = (String(raw).split('/').filter(Boolean).pop() || '').toLowerCase();

  if (!slug) return notFound();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    // Our configuration is broken, not the product. 404 here would tell Google
    // the page is permanently gone.
    return unavailable('supabase env vars missing');
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data, error } = await supabase
      .from('custom_products')
      .select('*')
      .eq('slug', slug)
      .eq('is_active', true)
      .single();
    // "No rows" and "the database is unreachable" are different answers and must
    // not share a status code. PostgREST returns PGRST116 for an empty .single();
    // anything else — DNS failure, 5xx, auth — means we simply could not look.
    if (error && error.code !== 'PGRST116') throw new DatabaseDown(error.message || 'lookup failed');
    if (!data) return notFound();

    const { data: override } = await supabase
      .from('product_overrides')
      .select('title,author,category,price_inr,original_price_inr,is_active')
      .eq('slug', slug)
      .maybeSingle();
    const product = applyOverride(data, override);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // Browsers must revalidate so an already-open product tab does not keep
        // a pre-edit cover or price. Netlify's edge still caches the rendered
        // page for five minutes to protect Supabase from crawler egress.
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=300',
      },
      body: productHtml(product),
    };
  } catch (err) {
    if (err instanceof DatabaseDown || err?.name === 'DatabaseDown') {
      return unavailable(err.message);
    }
    // An unexpected render fault is still our problem, not a missing product.
    console.error('[product-page]', slug, err);
    return unavailable(err?.message || 'render failed');
  }
};
