"""
Generates akshar_co.html — the Akshar & Co. homepage with real book data
embedded from the 99bookstores scrape at ~/InkAndChaiBooks/ALL_BOOKS.json.
"""

import hashlib, json, re
import shutil
from html import escape as html_escape
from urllib.parse import quote
from datetime import datetime, timedelta
from pathlib import Path
from collections import Counter, defaultdict

# Anything scraped within the last NEW_ARRIVAL_DAYS is flagged as a new arrival.
NEW_ARRIVAL_DAYS = 30
_new_cutoff = (datetime.utcnow() - timedelta(days=NEW_ARRIVAL_DAYS)).isoformat()
SITE = "https://inkandchai.in"
IMAGE_PROXY_MAP = {}

def make_slug(title, shopify_id):
    """Generate a clean URL slug from title + last 5 chars of shopify_id."""
    if str(shopify_id or "") == "CUSTOM-KINGS-OF-SIN-COMPLETE-SET-6-AH":
        return "kings-of-sin-series-complete-set-6-books-ana-huang"
    if str(shopify_id or "") == "CUSTOM-HINDI-BESTSELLERS-COMBO-5":
        return "5-hindi-bestsellers-combo-set-of-5-books-MBO-5"
    if str(shopify_id or "") == "CUSTOM-100M-HINDI-COMBO-2":
        return "100m-leads-hindi-100m-offers-hindi-combo-2-books"
    if str(shopify_id or "") == "CUSTOM-GOGGINS-COMBO-HI":
        return "david-goggins-combo-hindi-cant-hurt-me-never-finished"
    if str(shopify_id or "") == "CUSTOM-MOTHER-MARY-COMES-TO-ME-HI-ARUNDHATI-ROY":
        return "mother-mary-comes-to-me-hindi-edition-arundhati-roy"
    slug = re.sub(r'[^a-z0-9]+', '-', (title or '').lower())
    slug = slug.strip('-')[:55]
    suffix = str(shopify_id or '')[-5:]
    return f"{slug}-{suffix}" if suffix else slug

def clean_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()

def public_image_url(url):
    """Hide third-party CDN fingerprints from public HTML while keeping images loadable."""
    url = str(url or "").strip()
    if not url or not url.startswith("http"):
        return url
    token = hashlib.sha256(url.encode("utf-8")).hexdigest()[:24]
    IMAGE_PROXY_MAP[token] = url
    return f"/.netlify/functions/image-proxy?i={token}"

def crawlable_image_url(url):
    """Use direct image URLs for Merchant Center and sitemaps.

    Public pages can hide source CDN fingerprints behind our proxy, but Google
    Merchant needs a plain crawlable image URL. Proxy URLs live under
    /.netlify/, which robots.txt blocks, so they must never be used in feeds.
    """
    url = str(url or "").strip()
    if not url:
        return ""
    if url.startswith("http"):
        return url
    if url.startswith("/"):
        return SITE + url
    return url

def product_path(slug):
    return f"/product/{slug}/"

def product_abs_url(slug):
    return f"{SITE}{product_path(slug)}"

# ── Load & deduplicate ───────────────────────────────────────────────────────
# Data lives in data/ALL_BOOKS.json (relative to this script) — works both locally and on Netlify
raw = json.loads((Path(__file__).parent / "data" / "ALL_BOOKS.json").read_text())

seen = {}
for b in raw:
    sid = b.get("shopify_id")
    if sid and sid not in seen and b.get("title"):
        seen[sid] = b

books = list(seen.values())
print(f"Unique books: {len(books)}")

# ── Category → tab mapping ───────────────────────────────────────────────────
FICTION_CATS = {
    "fiction", "all romance books", "romance (on sale)", "romance boxsets",
    "preloved fiction", "preloved romance", "preloved thriller & mystery",
    "preloved books", "preloved books at 99", "fiction & romance combos🔥",
    "colleen hoover special", "ana huang books", "freida mcfadden special",
    "lauren asher special", "elif shafak books", "ali hazelwood special",
}
NONFICTION_CATS = {
    "all self help", "self-help (on sale)", "non fictions", "non-fiction",
    "business and finance", "trading books", "science", "health & fitness",
    "biography and autobiography", "preloved biography", "preloved non-fiction",
    "personality", "self help boxsets", "self-help & finance combos🔥",
    "best self help books from publishers", "robert greene special",
    "robert t. kiyosaki books", "napoleon hill books", "joseph murphy books",
    "rhonda byrne books", "robin sharma", "brianna wiest books",
    "dale carnegie books", "stephen hawking books", "sadguru jaggi vasudev books",
}
POETRY_CATS = {"poetry"}
POETRY_TITLE_HINTS = {
    "poetry", "poem", "poems", "shayari", "ghazal", "gitanjali",
    "rumi", "jaun elia", "sun and her flowers", "milk and honey",
    "all this love", "all this light", "please love me at my worst",
    "the curse of letting go", "tamanna", "love poems",
}
INDIAN_CATS = {
    "mythology", "amish tripathi books", "indian writing", "spirituality",
    "best of spirituality and mythology", "chitra banerjee divakaruni books",
    "kevin missal books", "sudha murti special", "akshat gupta books",
}

def is_poetry_book(book):
    hay = " ".join(str(book.get(k, "")) for k in ("title", "author", "category", "tags")).lower()
    return (book.get("category", "").lower() in POETRY_CATS
            or any(hint in hay for hint in POETRY_TITLE_HINTS))

def tab_for(cat, book=None):
    c = cat.lower()
    if book and is_poetry_book(book): return "Poetry"
    if c in FICTION_CATS:       return "Fiction"
    if c in NONFICTION_CATS:    return "Non-Fiction"
    if c in POETRY_CATS:        return "Poetry"
    if c in INDIAN_CATS:        return "Indian Authors"
    return "All"

# ── Slim book objects for JS ─────────────────────────────────────────────────
slim = []
feed_image_by_slug = {}
for b in books:
    price = b.get("price_inr", "")
    try:
        price_f = float(price)
        price_str = f"₹ {price_f:,.0f}"
    except Exception:
        price_str = f"₹ {price}" if price else ""

    orig = b.get("original_price_inr", "")
    try:
        orig_f = float(orig)
        orig_str = f"₹ {orig_f:,.0f}" if orig_f > 0 else ""
    except Exception:
        orig_str = ""

    scraped = b.get("scraped_at", "")
    sid     = str(b.get("shopify_id") or "")
    # New-arrival rule: manually-curated additions (CUSTOM-…) OR anything
    # scraped strictly AFTER the bulk import date.
    BULK_IMPORT_DATE = "2026-04-23"  # bulk scrape was 2026-04-22
    is_new = 1 if (sid.startswith("CUSTOM-") or (scraped and scraped[:10] >= BULK_IMPORT_DATE)) else 0

    slug = make_slug(b["title"], b.get("shopify_id", ""))
    feed_image_by_slug[slug] = crawlable_image_url(b.get("image_url", ""))
    slim.append({
        "t":    clean_text(b["title"])[:220] if sid in {"CUSTOM-KINGS-OF-SIN-COMPLETE-SET-6-AH", "CUSTOM-HINDI-BESTSELLERS-COMBO-5", "CUSTOM-100M-HINDI-COMBO-2"} else clean_text(b["title"])[:80],
        "a":    clean_text(b.get("author", ""))[:50],
        "p":    price_str,
        "op":   orig_str,
        "img":  public_image_url(b.get("image_url", "")),
        "back_img": public_image_url(b.get("back_image_url", "")),
        "url":  product_path(slug),
        "slug": slug,
        "cat":  clean_text(b.get("category", "")),
        "tab":  tab_for(b.get("category", ""), b),
        "desc": (b.get("description") or "")[:1400],
        "isbn": clean_text(b.get("isbn", "")),
        "pub":  clean_text(b.get("publisher", "")),
        "n":    is_new,            # 1 = New Arrival
        "ts":   scraped,           # so we can sort newest-first when needed
        "pdf":  b.get("sample_pdf") or "",  # path to sample PDF (read-first-pages preview)
        "pdf_pages": b.get("sample_pdf_pages") or 0,
        # Codex-added review proof fields (kept alongside the new structured reviews)
        "rating": b.get("rating_value") or "",
        "review_count": b.get("review_count") or "",
        "order_badge": clean_text(b.get("order_badge", "")),
        "review_image": public_image_url(b.get("review_image_url", "")),
        "review_video": b.get("review_video_url") or "",
        # Customer reviews — list of { name, rating (1-5), text } objects.
        # Rendered on both SSR + dynamic product pages, contributes to JSON-LD.
        "reviews": list(b.get("reviews") or []),
    })

# Put new arrivals at the very front so they're discoverable on first scroll
slim.sort(key=lambda x: (-x["n"], -(x["ts"] or "")[:19].count("0")))  # new first

books_js = json.dumps(slim, ensure_ascii=False)
recent_order_activity_path = Path(__file__).parent / "data" / "recent_order_activity.json"
try:
    recent_order_activity = json.loads(recent_order_activity_path.read_text()) if recent_order_activity_path.exists() else []
except Exception:
    recent_order_activity = []
def _norm_activity_title(value):
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()

def _match_activity_book(title):
    needle = _norm_activity_title(str(title or "").split("+")[0])
    if not needle:
        return None
    for book in slim:
        hay = _norm_activity_title(book.get("t", "") + " " + book.get("a", ""))
        hay_prefix = hay[:38].strip()
        if (len(needle) >= 6 and needle in hay) or (len(hay_prefix) >= 10 and hay_prefix in needle):
            return book
    words = [w for w in needle.split() if len(w) > 3][:4]
    if len(words) >= 2:
        for book in slim:
            hay = _norm_activity_title(book.get("t", "") + " " + book.get("a", ""))
            if all(w in hay for w in words):
                return book
    return None

enriched_recent_order_activity = []
for item in recent_order_activity:
    matched = _match_activity_book(item.get("title", ""))
    enriched_recent_order_activity.append({
        "name": clean_text(item.get("name", "")),
        "title": clean_text(item.get("title", "")),
        "img": matched.get("img", "") if matched else "",
        "url": matched.get("url", "") if matched else "",
    })
recent_order_activity_js = json.dumps(enriched_recent_order_activity, ensure_ascii=False)
new_count = sum(b["n"] for b in slim)
print(f"New arrivals (last {NEW_ARRIVAL_DAYS} days): {new_count}")

# ── Real collection cards (top 5 by unique count) ───────────────────────────
cat_counts = Counter(b["category"] for b in books)
TOP_CATS = [
    ("Fiction & Romance",        ["fiction", "all romance books", "romance (on sale)"]),
    ("Self-Help",                ["all self help", "self-help (on sale)", "best self help books from publishers"]),
    ("Kids & Young Adult",       ["kids book", "kids book age: 3-5", "kids book age: 2-6", "kids book age: 5-8", "kids book age: 8-11"]),
    ("Manga & Comics",           ["manga", "comics", "dc comics", "marvel comics"]),
    ("Mythology & Spirituality", ["mythology", "best of spirituality and mythology", "spirituality", "amish tripathi books"]),
]

def slugify(s):
    return "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-").replace("--","-")

SITE = "https://inkandchai.in"

def product_path(slug):
    return f"/product/{slug}/"

def product_abs_url(slug):
    return f"{SITE}{product_path(slug)}"

coll_data = []
for name, cats in TOP_CATS:
    total = sum(cat_counts.get(c.title(), 0) + cat_counts.get(c, 0)
                for c in cats)
    # Pick a sample book image from any of the collection's categories for the thumbnail.
    # NOTE: raw books use 'image_url'; the slim/JS version is renamed to 'img'.
    thumb = ""
    for c in cats:
        cl = c.lower()
        for b in books:
            bcat = (b.get("category") or "").lower()
            url  = public_image_url(b.get("image_url") or b.get("img") or "")
            if bcat == cl and url:
                thumb = url
                break
        if thumb:
            break
    coll_data.append({
        "name": name,
        "slug": slugify(name),
        "count": max(total, 1),
        "cats": cats,
        "thumb": thumb,
    })

# ── All categories list (for category browser) ───────────────────────────────
# Use cat_counts but skip very small or duplicate-ish collections
SKIP_CATS = {"preloved biography", "preloved hardcover", "harry pottter",
             "dale carnegie books", "classics_", "robin sharma"}
all_cats = [
    {"name": cat, "count": count}
    for cat, count in sorted(cat_counts.items(), key=lambda x: -x[1])
    if count >= 2 and cat.lower() not in SKIP_CATS
]
all_cats_js = json.dumps(all_cats, ensure_ascii=False)
nav_categories_html = "\n        ".join(
    f'<a href="/category/{slugify(cat["name"])}/" role="menuitem">'
    f'<span>{html_escape(cat["name"])}</span><span class="nav-cat-count">{int(cat["count"])} books</span></a>'
    for cat in all_cats
)

META_PIXEL_CODE = """<!-- Meta Pixel Code -->
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
fbq('track', 'PageView');
</script>
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id=1702042431242274&ev=PageView&noscript=1"
/></noscript>
<!-- End Meta Pixel Code -->"""

GOOGLE_ADS_TAG = """<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=AW-18119332653"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'AW-18119332653');
</script>
<!-- End Google tag -->"""

def with_meta_pixel(html: str) -> str:
    tags = []
    if "1702042431242274" not in html:
        tags.append(META_PIXEL_CODE)
    if "googletagmanager.com/gtag/js?id=AW-18119332653" not in html:
        tags.append(GOOGLE_ADS_TAG)
    if not tags:
        return html
    return html.replace("</head>", "\n".join(tags) + "\n</head>", 1)

READER_ACTIVITY_CSS = r"""
/* Animated reader activity notification */
.reader-activity-toast{position:fixed;left:22px;bottom:96px;width:min(340px,calc(100vw - 32px));display:grid;grid-template-columns:58px 1fr 28px;gap:.85rem;align-items:center;padding:.72rem .72rem;background:rgba(250,247,242,.97);border:1px solid rgba(138,106,31,.25);box-shadow:0 18px 44px rgba(30,20,8,.18);z-index:8997;color:#2a2018;opacity:0;transform:translateY(18px);pointer-events:none;transition:opacity .35s ease,transform .35s ease;backdrop-filter:blur(12px)}
html:not([data-theme="light"]) .reader-activity-toast{background:rgba(20,18,16,.96);border-color:rgba(201,168,76,.24);box-shadow:0 18px 44px rgba(0,0,0,.42);color:#f0e8d8}
.reader-activity-toast.show{opacity:1;transform:translateY(0);pointer-events:auto}
.reader-activity-img{width:58px;height:78px;object-fit:cover;background:#f0e8d4;border:1px solid rgba(138,106,31,.22)}
.reader-activity-kicker{font-size:.58rem;letter-spacing:.13em;text-transform:uppercase;color:#8a6a1f;margin-bottom:.22rem}
html:not([data-theme="light"]) .reader-activity-kicker{color:#c9a84c}
.reader-activity-title{font-family:'Cormorant Garamond',serif;font-size:1rem;line-height:1.15;color:inherit;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.reader-activity-time{font-size:.62rem;color:#7d6d5b;margin-top:.35rem}
html:not([data-theme="light"]) .reader-activity-time{color:#a09080}
.reader-activity-close{width:28px;height:28px;border:0;background:transparent;color:inherit;font-size:1.15rem;line-height:1;cursor:pointer;opacity:.62}
.reader-activity-close:hover{opacity:1}
@media(max-width:780px){.reader-activity-toast{left:14px;bottom:146px;width:min(330px,calc(100vw - 28px));grid-template-columns:54px 1fr 26px;padding:.65rem}.reader-activity-img{width:54px;height:72px}.reader-activity-title{font-size:.95rem}}
@media(prefers-reduced-motion:reduce){.reader-activity-toast{transition:none}}
"""

READER_ACTIVITY_JS = r"""
<script>
(function(){
  const recentOrders = RECENT_ORDER_ACTIVITY_PLACEHOLDER;
  const names = ['Aarav','Ananya','Riya','Kabir','Priya','Arjun','Meera','Ishaan','Neha','Rohan','Sanya','Aditya','Kavya','Rahul','Nisha','Vivaan'];
  const cities = ['Delhi','Mumbai','Pune','Jaipur','Lucknow','Bengaluru','Hyderabad','Chandigarh','Ahmedabad','Indore','Kolkata','Surat'];
  const browseActions = ['added to cart', 'is checking out', 'is browsing', 'is viewing'];
  const orderActions = ['ordered', 'purchased'];
  const times = ['just now','2 minutes ago','5 minutes ago','12 minutes ago','today','yesterday'];
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const esc = s => String(s || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  function stopActivity(){
    sessionStorage.setItem('iac_reader_activity_closed','1');
    const el = document.getElementById('readerActivityToast');
    if (el) {
      el.classList.remove('show');
      window.clearTimeout(el._hideTimer);
    }
  }
  window.stopReaderActivity = stopActivity;
  function booksPool(){
    try {
      if (typeof BOOKS === 'undefined' || !Array.isArray(BOOKS)) {
        if (typeof currentItem !== 'undefined' && currentItem && currentItem.title && currentItem.img) {
          return [{
            t: currentItem.title,
            a: currentItem.author || '',
            img: currentItem.img,
            url: currentItem.url && String(currentItem.url).startsWith('/product/') ? currentItem.url : location.pathname,
            slug: ''
          }];
        }
        return [];
      }
      return BOOKS.filter(b => b && b.t && b.img && (b.url || b.slug))
        .filter(b => (b.n || /hindi|self help|romance|bestseller|combo/i.test((b.cat || '') + ' ' + b.t)))
        .slice(0, 180);
    } catch(e) { return []; }
  }
  function matchBook(title, pool){
    const needle = norm(String(title || '').split('+')[0]);
    if (!needle || !pool.length) return null;
    return pool.find(b => norm(b.t).includes(needle) || needle.includes(norm(b.t).slice(0, 38))) ||
      pool.find(b => {
        const words = needle.split(' ').filter(w => w.length > 3).slice(0, 4);
        const hay = norm(b.t + ' ' + (b.a || ''));
        return words.length >= 2 && words.every(w => hay.includes(w));
      }) || null;
  }
  function activityItem(pool){
    if (Array.isArray(recentOrders) && recentOrders.length && Math.random() < 0.58) {
      const order = pick(recentOrders);
      const match = matchBook(order.title, pool) || pick(pool);
      return {
        name: order.name || pick(names),
        city: 'India',
        action: pick(orderActions),
        title: order.title || match.t,
        img: order.img || match.img,
        url: order.url || match.url || ('/product/' + match.slug + '/'),
        time: pick(['yesterday','today','12 minutes ago','5 minutes ago'])
      };
    }
    const b = pick(pool);
    return {
      name: pick(names),
      city: pick(cities),
      action: pick(browseActions),
      title: b.t,
      img: b.img,
      url: b.url || ('/product/' + b.slug + '/'),
      time: pick(times)
    };
  }
  function ensureToast(){
    let el = document.getElementById('readerActivityToast');
    if (el) return el;
    el = document.createElement('aside');
    el.id = 'readerActivityToast';
    el.className = 'reader-activity-toast';
    el.setAttribute('aria-live','polite');
    el.setAttribute('aria-label','Reader activity');
    document.body.appendChild(el);
    return el;
  }
  function showActivity(){
    if (sessionStorage.getItem('iac_reader_activity_closed') === '1') return;
    const pool = booksPool();
    if (!pool.length) return;
    const item = activityItem(pool);
    const el = ensureToast();
    el.innerHTML = `
      <img class="reader-activity-img" src="${esc(item.img)}" alt="" loading="lazy"/>
      <div>
        <div class="reader-activity-kicker">${esc(item.name)} from ${esc(item.city)} ${esc(item.action)}</div>
        <div class="reader-activity-title">${esc(item.title)}</div>
        <div class="reader-activity-time">${esc(item.time)}</div>
      </div>
      <button class="reader-activity-close" type="button" aria-label="Hide reader activity">×</button>`;
    el.onclick = e => { if (!e.target.closest('button')) location.href = item.url; };
    el.querySelector('button').onclick = e => {
      e.stopPropagation();
      el.classList.remove('show');
      sessionStorage.setItem('iac_reader_activity_closed','1');
    };
    requestAnimationFrame(() => el.classList.add('show'));
    window.clearTimeout(el._hideTimer);
    el._hideTimer = window.setTimeout(() => el.classList.remove('show'), 6200);
  }
  function schedule(){
    const delay = 12000 + Math.floor(Math.random() * 12000);
    window.setTimeout(() => { showActivity(); schedule(); }, delay);
  }
  window.addEventListener('load', () => {
    if (sessionStorage.getItem('iac_reader_activity_closed') === '1') return;
    window.setTimeout(showActivity, 5200);
    schedule();
  });
  document.addEventListener('click', event => {
    const target = event.target.closest('button,a');
    if (!target) return;
    const onclick = target.getAttribute('onclick') || '';
    const href = target.getAttribute('href') || '';
    if (/buyNowBook|addBookToCart|checkout/i.test(onclick) || /\/checkout\/?/i.test(href)) {
      stopActivity();
    }
  }, true);
})();
</script>
"""

def with_reader_activity(html: str) -> str:
    if "reader-activity-toast" not in html:
        html = html.replace("</style>", READER_ACTIVITY_CSS + "\n</style>", 1)
    if "readerActivityToast" not in html:
        html = html.replace("</body>", READER_ACTIVITY_JS.replace("RECENT_ORDER_ACTIVITY_PLACEHOLDER", recent_order_activity_js) + "\n</body>", 1)
    return html

# ── HTML template ────────────────────────────────────────────────────────────
HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
<meta http-equiv="Pragma" content="no-cache" />
<meta http-equiv="Expires" content="0" />
<title>Ink & Chai — Buy Books Online India · Hindi & English · Free Shipping above ₹499</title>
<meta name="description" content="Buy books online in India at Ink & Chai. 2,300+ titles in Hindi and English — fiction, romance, self-help, mythology, manga & more. Free pan-India shipping above ₹499. Cash on delivery available. Genuine books, 7-day easy returns." />
<meta name="keywords" content="buy books online india, hindi books online, online bookstore india, self help books hindi, romance books, fiction books, manga books, ana huang books, david goggins hindi, robin sharma, robert kiyosaki, mythology books, books at 99, cash on delivery books, free shipping books india, ink and chai" />
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1" />
<meta name="author" content="Ink & Chai" />
<meta name="theme-color" content="#0d0b08" media="(prefers-color-scheme: dark)" />
<meta name="theme-color" content="#faf7f2" media="(prefers-color-scheme: light)" />
<meta name="geo.region" content="IN" />
<meta name="geo.placename" content="New Delhi" />
<meta name="language" content="English, Hindi" />
<link rel="canonical" href="https://inkandchai.in/" />
<link rel="alternate" type="application/rss+xml" title="Ink & Chai Product Feed" href="/feed.xml" />
<link rel="sitemap" type="application/xml" href="/sitemap.xml" />
<link rel="icon" type="image/png" sizes="32x32" href="/images/favicon-32.png" />
<link rel="icon" type="image/png" sizes="96x96" href="/images/favicon-96.png" />
<link rel="icon" type="image/png" sizes="192x192" href="/images/icon-192.png" />
<link rel="apple-touch-icon" href="/images/apple-touch-icon.png" />
<link rel="manifest" href="/manifest.json" />

<!-- Open Graph / Facebook / WhatsApp -->
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Ink & Chai" />
<meta property="og:title" content="Ink & Chai — Buy Books Online India · Free Shipping above ₹499" />
<meta property="og:description" content="2,300+ titles in Hindi and English. Curated fiction, romance, self-help, mythology & more. Free pan-India shipping above ₹499. Cash on delivery." />
<meta property="og:image" content="https://inkandchai.in/images/og-default.jpg" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:url" content="https://inkandchai.in/" />
<meta property="og:locale" content="en_IN" />

<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="Ink & Chai — Buy Books Online India" />
<meta name="twitter:description" content="2,300+ titles in Hindi and English. Free shipping above ₹499. COD available." />
<meta name="twitter:image" content="https://inkandchai.in/images/og-default.jpg" />

<!-- Structured Data: Organization -->
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "OnlineStore",
  "name": "Ink & Chai",
  "alternateName": "Ink and Chai",
  "url": "https://inkandchai.in",
  "logo": "https://inkandchai.in/images/og-default.jpg",
  "description": "Online bookstore in India offering 2,300+ titles in Hindi and English. Free shipping above ₹499, cash on delivery available, 7-day returns.",
  "address": {
    "@type": "PostalAddress",
    "streetAddress": "2969, Kucha Mai Dass, Sitaram Bazar",
    "addressLocality": "New Delhi",
    "postalCode": "110006",
    "addressCountry": "IN"
  },
  "contactPoint": {
    "@type": "ContactPoint",
    "telephone": "+91-9217175546",
    "contactType": "customer support",
    "email": "support@inkandchai.in",
    "availableLanguage": ["English", "Hindi"]
  },
  "sameAs": ["https://wa.me/919217175546"],
  "paymentAccepted": ["Credit Card", "UPI", "Net Banking", "Cash on Delivery"],
  "currenciesAccepted": "INR",
  "priceRange": "₹99–₹2999",
  "areaServed": "IN"
}
</script>

<!-- Structured Data: WebSite + SearchAction (sitelinks searchbox in Google) -->
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "name": "Ink & Chai",
  "url": "https://inkandchai.in",
  "potentialAction": {
    "@type": "SearchAction",
    "target": "https://inkandchai.in/?q={search_term_string}",
    "query-input": "required name=search_term_string"
  }
}
</script>
<script>
  // Apply saved theme BEFORE paint; light is the default storefront theme.
  (function(){ try { var t = localStorage.getItem('iac_theme'); if (t === 'light') document.documentElement.setAttribute('data-theme','light'); } catch(e){ /* dark default */ } })();
  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme');
    var next = cur === 'light' ? 'dark' : 'light';
    if (next) document.documentElement.setAttribute('data-theme', next);
    else      document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('iac_theme', next); } catch(e){}
  }
</script>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400;1,600&family=Montserrat:wght@300;400;500;600&family=Cinzel:wght@400;700;900&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg: #0d0b08; --bg2: #141210; --bg3: #1c1916;
    --gold: #c9a84c; --gold-light: #e8c97a; --gold-dim: #7a6330;
    --cream: #f0e8d8; --cream-dim: #a09080; --white: #faf7f2;
    --border: rgba(201,168,76,0.18);
    --shadow-color: rgba(0,0,0,0.6);
  }
  /* LIGHT MODE */
  html[data-theme="light"] {
    --bg: #faf7f2; --bg2: #f3ece0; --bg3: #ffffff;
    --gold: #8a6a1f; --gold-light: #b8902c; --gold-dim: #6a4f10;
    --cream: #2a2018; --cream-dim: #5a4a38; --white: #0d0b08;
    --border: rgba(138,106,31,0.28);
    --shadow-color: rgba(60,40,10,0.12);
  }
  html[data-theme="light"] body { background: var(--bg); color: var(--cream); }
  html[data-theme="light"] nav { background: linear-gradient(to bottom, rgba(250,247,242,0.97) 0%, transparent 100%); }
  html[data-theme="light"] .promo-banner { background: linear-gradient(90deg,#fff8e6,#fbeec8,#fff8e6); color: #5a4a18; }
  html[data-theme="light"] .promo-banner code { background: rgba(138,106,31,0.12); color: #6a4f10; border-color: rgba(138,106,31,0.4); }
  html[data-theme="light"] .marquee-bar { background: var(--gold); }
  html[data-theme="light"] .marquee-item { color: #fff; }
  html[data-theme="light"] .book-cover { background: #f0e8d4; }
  html[data-theme="light"] .coll-overlay { background: linear-gradient(to top, rgba(255,255,255,0.65) 0%, transparent 60%); }
  html[data-theme="light"] .coll-name, html[data-theme="light"] .section-title, html[data-theme="light"] .hero-title { color: #1a1208; }
  html[data-theme="light"] .coll-desc { color: #4a3a25; }
  html[data-theme="light"] .footer { background: #1a1410; color: #e8dcc4; }
  html[data-theme="light"] .editorial-quote { color: #1a1208; }
  html[data-theme="light"] .cart-sidebar, html[data-theme="light"] .modal-content { color: var(--cream); }

  /* Theme toggle button */
  .theme-toggle { background: transparent; border: 1px solid var(--gold-dim); color: var(--gold); width: 38px; height: 38px; border-radius: 50%; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; font-size: 1rem; transition: all 0.3s; margin-right: 0.6rem; }
  .theme-toggle:hover { background: var(--gold); color: var(--bg); transform: rotate(20deg); }
  .theme-toggle .sun { display: none; }
  html[data-theme="light"] .theme-toggle .moon { display: none; }
  html[data-theme="light"] .theme-toggle .sun { display: inline; }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; background: #0d0b08; max-width:100%; overflow-x:hidden; }
  html[data-theme="light"] { background: #faf7f2; }
  body { background: var(--bg); color: var(--cream); font-family: 'Montserrat', sans-serif; font-weight: 400; overflow-x: hidden; min-height: 100vh; }
  /* Hard fallback: if anything goes wrong with vars, content still readable */
  html:not([data-theme="light"]) body { background: #0d0b08; color: #f0e8d8; }
  html[data-theme="light"] body { background: #faf7f2; color: #2a2018; }

  body::before {
    content: ''; position: fixed; inset: 0;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
    pointer-events: none; z-index: 999; opacity: 0.4;
  }

  /* NAV */
  nav { position: fixed; top: 0; left: 0; right: 0; z-index: 100; display: flex; align-items: center; justify-content: space-between; padding: 1.4rem 4rem; background: linear-gradient(to bottom, rgba(13,11,8,0.97) 0%, transparent 100%); border-bottom: 1px solid var(--border); backdrop-filter: blur(12px); }
  .nav-logo { display: inline-flex; align-items: center; gap: 0.5rem; font-family: 'Cormorant Garamond', serif; font-size: 1.5rem; font-weight: 600; letter-spacing: 0.08em; color: var(--gold); text-decoration: none; }
  .nav-logo .logo-img { height: 38px; width: auto; display: block; }
  .nav-logo .logo-light { display: none; }
  html[data-theme="light"] .nav-logo .logo-dark  { display: none; }
  html[data-theme="light"] .nav-logo .logo-light { display: block; }
  @media(max-width:780px) { .nav-logo .logo-img { height: 32px; } }
  .nav-links { display: flex; gap: 2.8rem; list-style: none; }
  .nav-links a { font-size: 0.68rem; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cream-dim); text-decoration: none; transition: color 0.3s; }
  .nav-links a:hover { color: var(--gold); }
  .nav-links li { position: relative; }
  .nav-dropdown-menu::after { content: ''; position: absolute; left: -1rem; right: -1rem; top: 100%; height: 1rem; }
  .nav-dropdown-trigger { display: inline-flex; align-items: center; gap: 0.35rem; }
  .nav-dropdown-trigger::after { content: '⌄'; font-size: 0.72em; line-height: 1; color: var(--gold-dim); }
  .nav-dropdown { position: absolute; top: calc(100% + 0.9rem); left: 50%; transform: translateX(-50%) translateY(8px); max-height: 70vh; overflow: auto; display: grid; gap: 0.15rem 0.75rem; padding: 1rem; background: rgba(13,11,8,0.97); border: 1px solid var(--border); box-shadow: 0 18px 50px rgba(0,0,0,0.32); opacity: 0; visibility: hidden; pointer-events: none; transition: opacity 0.18s, transform 0.18s, visibility 0.18s; z-index: 350; }
  .nav-cat-dropdown { width: min(760px, 90vw); grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .nav-policy-dropdown { width: min(310px, 82vw); grid-template-columns: 1fr; }
  html[data-theme="light"] .nav-dropdown { background: rgba(250,247,242,0.98); box-shadow: 0 18px 48px rgba(80,55,20,0.14); }
  .nav-dropdown-menu:hover .nav-dropdown, .nav-dropdown-menu:focus-within .nav-dropdown { opacity: 1; visibility: visible; pointer-events: auto; transform: translateX(-50%) translateY(0); }
  .nav-dropdown a { display: flex; justify-content: space-between; align-items: center; gap: 0.8rem; padding: 0.55rem 0.65rem; border: 1px solid transparent; font-size: 0.58rem; letter-spacing: 0.12em; line-height: 1.35; white-space: normal; }
  .nav-dropdown a:hover { border-color: var(--border); background: rgba(201,168,76,0.08); }
  .nav-cat-count { flex: 0 0 auto; color: var(--gold-dim); font-size: 0.72em; letter-spacing: 0.04em; text-transform: none; }
  .nav-actions { display: flex; gap: 1.4rem; align-items: center; }
  .nav-icon { color: var(--cream-dim); cursor: pointer; transition: color 0.3s; font-size: 1rem; }
  .nav-icon:hover { color: var(--gold); }
  .nav-search-btn { color: var(--cream-dim); cursor: pointer; transition: color 0.3s, border-color 0.3s, background 0.3s; font: inherit; background: transparent; border: 0; padding: 0; display: inline-flex; align-items: center; justify-content: center; font-size: 1rem; }
  .nav-search-btn:hover { color: var(--gold); }
  .nav-search-label { display: none; }
  .btn-nav { font-family: 'Montserrat', sans-serif; font-size: 0.62rem; letter-spacing: 0.22em; text-transform: uppercase; padding: 0.55rem 1.4rem; border: 1px solid var(--gold-dim); color: var(--gold); background: transparent; cursor: pointer; transition: all 0.3s; text-decoration: none; }
  .btn-nav:hover { background: var(--gold); color: var(--bg); border-color: var(--gold); }

  /* HERO */
  .hero { min-height: 100vh; display: grid; grid-template-columns: 1fr 1fr; position: relative; overflow: hidden; }
  .hero-left { display: flex; flex-direction: column; justify-content: center; padding: 10rem 5rem 6rem 6rem; position: relative; z-index: 2; }
  .hero-eyebrow { font-size: 0.62rem; letter-spacing: 0.35em; text-transform: uppercase; color: var(--gold); margin-bottom: 2rem; display: flex; align-items: center; gap: 1rem; }
  .hero-eyebrow::before { content: ''; display: inline-block; width: 40px; height: 1px; background: var(--gold); }
  .hero-title { font-family: 'Cormorant Garamond', serif; font-size: clamp(3.2rem, 6vw, 5.5rem); font-weight: 400; line-height: 1.06; color: var(--white); margin-bottom: 2rem; letter-spacing: -0.01em; }
  .hero-title em { font-style: italic; color: var(--gold-light); }
  .hero-sub { font-size: 0.82rem; line-height: 1.9; color: var(--cream-dim); max-width: 380px; margin-bottom: 3.5rem; letter-spacing: 0.04em; }
  .hero-ctas { display: flex; gap: 1.2rem; align-items: center; }
  .btn-primary { font-family: 'Montserrat', sans-serif; font-size: 0.65rem; letter-spacing: 0.25em; text-transform: uppercase; padding: 1rem 2.4rem; background: var(--gold); color: var(--bg); border: none; cursor: pointer; font-weight: 500; transition: all 0.3s; text-decoration: none; display: inline-block; }
  .btn-primary:hover { background: var(--gold-light); transform: translateY(-1px); box-shadow: 0 8px 24px rgba(201,168,76,0.25); }
  .btn-ghost { font-size: 0.65rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--cream-dim); text-decoration: none; display: flex; align-items: center; gap: 0.6rem; transition: color 0.3s; }
  .btn-ghost:hover { color: var(--gold); }
  .btn-ghost::after { content: '→'; transition: transform 0.3s; }
  .btn-ghost:hover::after { transform: translateX(4px); }
  .hero-stats { display: flex; gap: 3rem; margin-top: 4rem; padding-top: 2.5rem; border-top: 1px solid var(--border); }
  .stat-num { font-family: 'Cormorant Garamond', serif; font-size: 2rem; font-weight: 600; color: var(--gold); line-height: 1; }
  .stat-label { font-size: 0.6rem; letter-spacing: 0.2em; text-transform: uppercase; color: var(--cream-dim); margin-top: 0.3rem; }
  .hero-right { position: relative; overflow: hidden; display:flex; align-items:center; justify-content:center; padding:8rem 5rem 5rem 1rem; }
  .hero-right::before { content: ''; position: absolute; inset: 0; background: radial-gradient(circle at 58% 38%, rgba(201,168,76,0.14), transparent 34%), linear-gradient(to right, var(--bg) 0%, rgba(13,11,8,0.2) 38%, var(--bg) 100%), linear-gradient(to bottom, transparent 58%, var(--bg) 100%); z-index: 1; }
  .hero-cover-wall { position:relative; z-index:2; width:min(680px,100%); display:grid; grid-template-columns:repeat(4,minmax(105px,1fr)); gap:1.1rem; transform:rotate(2deg); }
  .hero-cover-card { position:relative; display:block; aspect-ratio:2/3; background:var(--bg2); border:1px solid rgba(201,168,76,0.28); box-shadow:0 18px 42px rgba(0,0,0,0.5); overflow:hidden; transition:transform 0.25s,border-color 0.25s,box-shadow 0.25s; text-decoration:none; }
  .hero-cover-card:nth-child(2),.hero-cover-card:nth-child(5){transform:translateY(2rem)}
  .hero-cover-card:nth-child(4),.hero-cover-card:nth-child(7){transform:translateY(-1.2rem)}
  .hero-cover-card:hover{transform:translateY(-0.35rem) scale(1.02);border-color:rgba(201,168,76,0.7);box-shadow:0 24px 55px rgba(0,0,0,0.65)}
  .hero-cover-card:nth-child(2):hover,.hero-cover-card:nth-child(5):hover{transform:translateY(1.65rem) scale(1.02)}
  .hero-cover-card:nth-child(4):hover,.hero-cover-card:nth-child(7):hover{transform:translateY(-1.55rem) scale(1.02)}
  .hero-cover-card.featured { grid-row:span 2; }
  .hero-cover-card img { width:100%; height:100%; object-fit:cover; display:block; }
  .hero-cover-card::after { content:attr(data-label); position:absolute; left:0; right:0; bottom:0; padding:1.6rem 0.7rem 0.65rem; background:linear-gradient(to top,rgba(0,0,0,0.88),transparent); color:var(--cream); font-size:0.54rem; letter-spacing:0.16em; text-transform:uppercase; line-height:1.35; opacity:0; transform:translateY(8px); transition:opacity 0.25s,transform 0.25s; }
  .hero-cover-card:hover::after { opacity:1; transform:translateY(0); }
  .hero-note { position:absolute; z-index:3; right:5rem; bottom:6.2rem; max-width:280px; padding:1rem 1.15rem; background:rgba(13,11,8,0.78); border:1px solid rgba(201,168,76,0.28); backdrop-filter:blur(10px); color:var(--cream-dim); font-size:0.64rem; letter-spacing:0.08em; line-height:1.7; text-transform:uppercase; }
  .hero-note strong { color:var(--gold); font-weight:500; }

  /* MARQUEE */
  .marquee-bar { background: var(--gold); padding: 0.75rem 0; overflow: hidden; white-space: nowrap; }
  .marquee-track { display: inline-flex; animation: marquee 30s linear infinite; }
  .marquee-item { font-size: 0.6rem; letter-spacing: 0.3em; text-transform: uppercase; color: var(--bg); font-weight: 500; padding: 0 2.5rem; }
  .marquee-dot { color: rgba(13,11,8,0.4); }
  @keyframes marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }

  /* HERO BANNER CAROUSEL */
  .banners { position: relative; max-width: 1400px; margin: 2rem auto; padding: 0 1.5rem; }
  /* Aspect ratio MUST match the banner image (~2.5/1) so we don't have to crop */
  .banner-viewport { position: relative; overflow: hidden; aspect-ratio: 2.5 / 1; background: var(--bg2); border: 1px solid var(--border); }
  @media(max-width:780px) {
    /* Same 2.5/1 ratio on mobile — banner shows full width, no L/R cropping */
    .banner-viewport { aspect-ratio: 2.5 / 1; border-left: none; border-right: none; }
    .banners { padding: 0; margin: 0.8rem auto; }
  }
  .banner-track { display: flex; height: 100%; transition: transform 0.55s cubic-bezier(0.45, 0, 0.15, 1); will-change: transform; }
  .banner-slide { flex: 0 0 100%; position: relative; cursor: pointer; }
  /* contain (not cover) so the whole banner is visible — no left/right crop */
  .banner-slide img { width: 100%; height: 100%; object-fit: contain; display: block; user-select: none; -webkit-user-drag: none; background: var(--bg2); }

  /* Side arrows (desktop only) */
  .banner-arrow { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(13,11,8,0.55); color: var(--gold); width: 40px; height: 40px; border-radius: 50%; border: 1px solid rgba(201,168,76,0.4); cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 1.2rem; font-family: 'Cormorant Garamond', serif; z-index: 3; transition: all 0.25s; backdrop-filter: blur(8px); }
  .banner-arrow:hover { background: var(--gold); color: var(--bg); transform: translateY(-50%) scale(1.05); }
  .banner-arrow.prev { left: 1rem; }
  .banner-arrow.next { right: 1rem; }
  @media(max-width:780px) { .banner-arrow { display: none; } }

  /* Dots indicator */
  .banner-dots { position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%); display: flex; gap: 8px; z-index: 3; padding: 6px 12px; background: rgba(13,11,8,0.4); border-radius: 30px; backdrop-filter: blur(6px); }
  .banner-dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(255,255,255,0.5); border: none; cursor: pointer; padding: 0; transition: all 0.3s; }
  .banner-dot.active { background: var(--gold); width: 24px; border-radius: 4px; }
  .banner-dot:hover { background: rgba(255,255,255,0.85); }
  .banner-dot.active:hover { background: var(--gold); }

  /* ── KING OF GLUTTONY FEATURED BANNER ───────────────────────────── */
  .kog-banner-wrap { display:block; text-decoration:none; max-width:1400px; margin:2rem auto; padding:0 1.5rem; }
  @media(max-width:780px){ .kog-banner-wrap { padding:0; margin:0.8rem auto; } }
  .kog-banner {
    width:100%; position:relative; overflow:hidden;
    background:linear-gradient(135deg,#0d0a05 0%,#1c1408 40%,#0f0c06 100%);
    border:1px solid rgba(212,175,55,0.3);
    aspect-ratio:2.8/1;
    cursor:pointer;
  }
  @media(max-width:780px){ .kog-banner { aspect-ratio:unset; min-height:200px; } }
  .kog-banner::before {
    content:''; position:absolute; inset:0; pointer-events:none;
    background-image:
      radial-gradient(ellipse 60% 80% at 70% 50%,rgba(212,175,55,0.06) 0%,transparent 70%),
      radial-gradient(ellipse 30% 40% at 20% 50%,rgba(212,175,55,0.04) 0%,transparent 60%);
  }
  .kog-banner::after {
    content:''; position:absolute; top:10px; left:10px; right:10px; bottom:10px;
    border:1px solid rgba(212,175,55,0.13); pointer-events:none;
  }
  /* Book image — floats on the right */
  .kog-book-wrap {
    position:absolute; right:5%; top:50%; transform:translateY(-50%) rotate(-4deg);
    width:min(180px,22%);
    filter:drop-shadow(-16px 16px 36px rgba(0,0,0,0.8)) drop-shadow(-3px 3px 10px rgba(212,175,55,0.2));
    animation:kogFloat 4s ease-in-out infinite; z-index:2;
  }
  .kog-book-wrap img { width:100%; display:block; border-radius:2px; }
  @keyframes kogFloat {
    0%,100%{ transform:translateY(-50%) rotate(-4deg); }
    50%{ transform:translateY(calc(-50% - 7px)) rotate(-3deg); }
  }
  /* Price tag */
  .kog-price {
    position:absolute; right:calc(5% + min(180px,22%) - 30px); bottom:14%;
    z-index:3; background:linear-gradient(135deg,#c9a227,#e8c84a,#b8891e);
    color:#1a1209; font-family:'Cinzel',serif; font-weight:700; font-size:clamp(13px,1.5vw,18px);
    padding:6px 16px; letter-spacing:1px;
    box-shadow:0 4px 20px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.2);
    animation:kogPricePulse 3s ease-in-out infinite;
  }
  .kog-price::before { content:'₹'; font-size:0.72em; vertical-align:super; margin-right:1px; }
  @keyframes kogPricePulse {
    0%,100%{ box-shadow:0 4px 20px rgba(0,0,0,0.5),0 0 0 0 rgba(212,175,55,0); }
    50%{ box-shadow:0 4px 20px rgba(0,0,0,0.5),0 0 18px 4px rgba(212,175,55,0.3); }
  }
  /* Left content */
  .kog-content {
    position:absolute; left:0; top:0; bottom:0; width:60%;
    display:flex; flex-direction:column; justify-content:center;
    padding:clamp(20px,3vw,40px) clamp(24px,3vw,40px) clamp(20px,3vw,40px) clamp(28px,4vw,50px);
    z-index:2;
  }
  .kog-store-label { font-family:'Cinzel',serif; font-size:clamp(7px,0.65vw,10px); letter-spacing:5px; color:rgba(212,175,55,0.6); text-transform:uppercase; margin-bottom:clamp(8px,1.2vw,16px); animation:kogFadeUp 0.8s ease both; }
  .kog-series { display:inline-flex; align-items:center; gap:8px; margin-bottom:clamp(6px,1vw,12px); animation:kogFadeUp 0.9s ease both; }
  .kog-series-line { width:20px; height:1px; background:rgba(212,175,55,0.5); }
  .kog-series-text { font-family:'Cormorant Garamond',serif; font-size:clamp(8px,0.85vw,11px); letter-spacing:3px; color:rgba(212,175,55,0.7); text-transform:uppercase; font-style:italic; }
  .kog-title { font-family:'Cinzel',serif; font-weight:900; font-size:clamp(20px,4vw,44px); line-height:1; color:transparent; background:linear-gradient(180deg,#f0d060 0%,#c9a227 40%,#a07818 100%); -webkit-background-clip:text; background-clip:text; letter-spacing:2px; margin-bottom:6px; animation:kogFadeUp 1s ease both; }
  .kog-subtitle { font-family:'Cormorant Garamond',serif; font-size:clamp(8px,0.95vw,13px); letter-spacing:4px; color:rgba(212,175,55,0.5); text-transform:uppercase; margin-bottom:clamp(8px,1.4vw,18px); animation:kogFadeUp 1.1s ease both; }
  .kog-divider { width:50px; height:1px; background:linear-gradient(90deg,rgba(212,175,55,0.6),transparent); margin-bottom:clamp(8px,1.2vw,16px); animation:kogFadeUp 1.2s ease both; }
  .kog-author { font-family:'Cormorant Garamond',serif; font-size:clamp(9px,1vw,15px); letter-spacing:2px; color:rgba(255,255,255,0.5); margin-bottom:2px; animation:kogFadeUp 1.3s ease both; }
  .kog-author strong { color:rgba(255,255,255,0.82); font-weight:600; }
  .kog-bestseller { font-family:'Cormorant Garamond',serif; font-size:clamp(7px,0.8vw,11px); letter-spacing:3px; color:rgba(212,175,55,0.5); font-style:italic; text-transform:uppercase; margin-bottom:clamp(10px,1.6vw,22px); animation:kogFadeUp 1.35s ease both; }
  .kog-cta {
    display:inline-flex; align-items:center; gap:8px;
    border:1px solid rgba(212,175,55,0.5); color:rgba(212,175,55,0.9);
    font-family:'Cinzel',serif; font-size:clamp(7px,0.75vw,11px); letter-spacing:3px;
    padding:clamp(8px,1vw,12px) clamp(14px,2vw,24px); text-transform:uppercase;
    width:fit-content; position:relative; overflow:hidden;
    transition:border-color 0.3s,color 0.3s; animation:kogFadeUp 1.5s ease both;
    text-decoration:none; background:transparent;
  }
  .kog-cta::before { content:''; position:absolute; inset:0; background:rgba(212,175,55,0.08); transform:translateX(-100%); transition:transform 0.4s ease; }
  .kog-banner:hover .kog-cta::before { transform:translateX(0); }
  .kog-banner:hover .kog-cta { border-color:rgba(212,175,55,0.9); color:#f0d060; }
  .kog-cta-arrow { font-size:1.1em; transition:transform 0.3s ease; }
  .kog-banner:hover .kog-cta-arrow { transform:translateX(4px); }
  /* Spark particles */
  .kog-spark { position:absolute; border-radius:50%; background:#e8832a; z-index:1; }
  .kog-spark-1 { width:3px; height:3px; right:calc(5% + min(180px,22%) + 18px); top:50%; animation:kogSpark1 3s ease-in-out infinite; }
  .kog-spark-2 { width:2px; height:2px; right:calc(5% + min(180px,22%) + 44px); top:54%; animation:kogSpark2 4s ease-in-out infinite 0.5s; }
  .kog-spark-3 { width:3px; height:3px; background:#d4661a; right:calc(5% + min(180px,22%) + 6px); top:52%; animation:kogSpark3 3.5s ease-in-out infinite 1s; }
  @keyframes kogSpark1 { 0%,100%{opacity:0;transform:translate(0,0) scale(1)} 30%{opacity:.8} 100%{transform:translate(-8px,-20px) scale(0);opacity:0} }
  @keyframes kogSpark2 { 0%,100%{opacity:0;transform:translate(0,0) scale(1)} 40%{opacity:.6} 100%{transform:translate(4px,-18px) scale(0);opacity:0} }
  @keyframes kogSpark3 { 0%,100%{opacity:0;transform:translate(0,0) scale(1)} 35%{opacity:.7} 100%{transform:translate(-3px,-22px) scale(0);opacity:0} }
  @keyframes kogFadeUp { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
  .kog-crown { position:absolute; top:clamp(10px,2vw,28px); left:clamp(16px,3vw,50px); font-size:clamp(12px,1.5vw,18px); opacity:0.4; z-index:2; animation:kogFadeUp 0.7s ease both; }
  /* Mobile adjustments */
  @media(max-width:600px){
    .kog-content{ width:68%; padding:14px 10px 14px 16px; }
    .kog-book-wrap{ width:28%; right:3%; }
    .kog-price{ right:calc(3% + 28% - 20px); font-size:11px; padding:4px 10px; }
    .kog-spark-1,.kog-spark-2,.kog-spark-3{ display:none; }
  }

  /* SECTIONS SHARED */
  section { padding: 7rem 6rem; }
  .section-label { font-size: 0.6rem; letter-spacing: 0.35em; text-transform: uppercase; color: var(--gold); margin-bottom: 1rem; display: flex; align-items: center; gap: 1rem; }
  .section-label::before { content: ''; display: inline-block; width: 30px; height: 1px; background: var(--gold); }
  .section-title { font-family: 'Cormorant Garamond', serif; font-size: clamp(2rem, 4vw, 3.2rem); font-weight: 400; color: var(--white); line-height: 1.12; margin-bottom: 1rem; letter-spacing: -0.01em; }
  .section-title em { font-style: italic; color: var(--gold-light); }

  /* ── SUMMER SALE BANNER ──────────────────────────────────────────── */
  .summer-sale-banner { background: linear-gradient(135deg,#8b1a1a 0%,#6b0f0f 45%,#8b1a1a 100%); border-bottom: 1px solid rgba(255,120,120,0.25); padding: 2.8rem 6rem; position: relative; overflow: hidden; }
  .summer-sale-banner::before { content:''; position:absolute; inset:0; background:url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.03'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E"); }
  .summer-sale-inner { display:flex; align-items:center; justify-content:space-between; gap:2rem; position:relative; }
  .summer-sale-left { flex:1; }
  .sale-eyebrow { font-size:0.52rem; letter-spacing:0.3em; text-transform:uppercase; color:rgba(255,200,200,0.85); margin-bottom:0.5rem; }
  .sale-headline { font-family:'Cormorant Garamond',serif; font-size:clamp(1.7rem,3.5vw,2.6rem); font-weight:400; color:#fff; line-height:1.1; margin-bottom:0.55rem; }
  .sale-headline em { font-style:italic; color:#ffb3b3; }
  .sale-code-row { display:flex; align-items:center; gap:0.8rem; flex-wrap:wrap; }
  .sale-code-label { font-size:0.62rem; color:rgba(255,255,255,0.75); letter-spacing:0.08em; }
  .sale-code { background:rgba(255,255,255,0.15); border:1px dashed rgba(255,255,255,0.5); color:#fff; font-family:'Montserrat',sans-serif; font-size:0.78rem; font-weight:700; letter-spacing:0.22em; padding:0.3rem 0.75rem; cursor:pointer; transition:background 0.2s; }
  .sale-code:hover { background:rgba(255,255,255,0.25); }
  /* Countdown */
  .sale-countdown-wrap { flex-shrink:0; text-align:center; }
  .sale-countdown-label { font-size:0.5rem; letter-spacing:0.25em; text-transform:uppercase; color:rgba(255,200,200,0.8); margin-bottom:0.6rem; }
  .sale-countdown { display:flex; align-items:flex-start; gap:0.4rem; }
  .cd-block { background:rgba(0,0,0,0.35); border:1px solid rgba(255,255,255,0.18); padding:0.65rem 0.85rem; text-align:center; min-width:56px; backdrop-filter:blur(4px); }
  .cd-num { font-family:'Montserrat',sans-serif; font-size:1.7rem; font-weight:700; color:#fff; line-height:1; display:block; }
  .cd-label { font-size:0.4rem; letter-spacing:0.18em; text-transform:uppercase; color:rgba(255,255,255,0.65); display:block; margin-top:0.2rem; }
  .cd-sep { font-size:1.6rem; color:rgba(255,255,255,0.5); line-height:1.15; padding-top:0.55rem; font-weight:300; align-self:flex-start; }
  @media(max-width:1100px) { .summer-sale-banner { padding:2rem 2.5rem; } }
  @media(max-width:780px) {
    .summer-sale-banner { padding:1.4rem 0.85rem; }
    .summer-sale-inner { flex-direction:column; gap:1.2rem; align-items:flex-start; }
    .cd-block { min-width:48px; padding:0.5rem 0.6rem; }
    .cd-num { font-size:1.3rem; }
    .sale-headline { font-size:1.45rem; }
  }
  /* Sale price on product page */
  .prod-sale-box { margin:0.75rem 0 0.25rem; padding:0.75rem 1rem; background:rgba(139,26,26,0.12); border:1px solid rgba(180,40,40,0.3); border-left:3px solid #c0392b; }
  .prod-sale-box-head { font-size:0.55rem; letter-spacing:0.2em; text-transform:uppercase; color:#e87070; margin-bottom:0.4rem; }
  .prod-sale-price { font-family:'Cormorant Garamond',serif; font-size:1.5rem; color:#e87070; font-weight:600; }
  .prod-sale-saving { font-size:0.65rem; color:rgba(232,112,112,0.8); margin-left:0.5rem; }
  .prod-sale-code { margin-top:0.4rem; font-size:0.6rem; color:rgba(255,200,200,0.8); letter-spacing:0.06em; }
  .prod-sale-code strong { color:#e87070; letter-spacing:0.15em; cursor:pointer; }
  /* Sale badge on book cards */
  .summer-badge { position:absolute; top:8px; right:8px; z-index:5; background:linear-gradient(135deg,#c0392b,#962d22); color:#fff; font-size:0.48rem; letter-spacing:0.16em; font-weight:700; padding:0.28rem 0.5rem; font-family:'Montserrat',sans-serif; box-shadow:0 3px 8px rgba(192,57,43,0.5); }
  /* Product page sale countdown */
  .prod-sale-timer { display:flex; align-items:center; gap:0.6rem; margin-top:0.5rem; flex-wrap:wrap; }
  .prod-cd-label { font-size:0.52rem; letter-spacing:0.14em; text-transform:uppercase; color:#e87070; }
  .prod-cd { display:flex; gap:0.25rem; align-items:flex-start; }
  .prod-cd-block { background:rgba(139,26,26,0.2); border:1px solid rgba(180,40,40,0.35); padding:0.3rem 0.45rem; text-align:center; min-width:34px; }
  .prod-cd-num { font-family:'Montserrat',sans-serif; font-size:0.9rem; font-weight:700; color:#e87070; display:block; line-height:1; }
  .prod-cd-lbl { font-size:0.35rem; letter-spacing:0.1em; text-transform:uppercase; color:rgba(232,112,112,0.7); display:block; }
  .prod-cd-sep { font-size:0.9rem; color:rgba(232,112,112,0.5); line-height:1.4; font-weight:300; }

  /* FEATURED BOOKS */
  .featured { background: var(--bg2); }
  .featured-header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 4rem; }
  .tabs { display: flex; gap: 0.4rem; border-bottom: 1px solid var(--border); padding-bottom: 0; margin-top: 1.5rem; }
  .tab { font-size: 0.62rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--cream-dim); padding: 0.5rem 1.2rem 0.8rem; cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.3s; margin-bottom: -1px; background: none; border-top: none; border-left: none; border-right: none; font-family: 'Montserrat', sans-serif; }
  .tab.active { color: var(--gold); border-bottom-color: var(--gold); }
  .tab:hover { color: var(--gold-light); }

  /* Book grid */
  .books-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 1.4rem; width: 100%; max-width: 100%; }
  @media(max-width:1100px){ .books-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  @media(max-width:880px) { .books-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  .book-card { cursor: pointer; min-width: 0; max-width: 100%; }
  .book-cover { aspect-ratio: 2/3; max-height: 320px; position: relative; overflow: hidden; margin-bottom: 1rem; border: 1px solid var(--border); background: #1a1208; display: flex; align-items: center; justify-content: center; transition: border-color 0.35s ease, box-shadow 0.35s ease; }
  .book-card:hover .book-cover { border-color: rgba(201,168,76,0.55); box-shadow: 0 12px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(201,168,76,0.15); }
  /* contain (not cover) so wide combo images aren't cropped — full image always visible */
  .book-cover img { width: 100%; height: 100%; object-fit: contain; display: block; transition: transform 0.5s ease; }
  .book-card:hover .book-cover img { transform: scale(1.06); }
  @media(max-width:780px) { .book-cover { max-height: 220px; margin-bottom: 0.7rem; } }
  .book-cover-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.65); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.6rem; opacity: 0; transition: opacity 0.3s; padding: 1rem; }
  .book-card:hover .book-cover-overlay { opacity: 1; }
  .book-cover-title { font-family: 'Cormorant Garamond', serif; font-size: 0.9rem; color: var(--white); text-align: center; line-height: 1.3; }
  .btn-add { font-size: 0.58rem; letter-spacing: 0.22em; text-transform: uppercase; color: var(--bg); background: var(--gold); border: none; padding: 0.7rem 1.4rem; cursor: pointer; font-family: 'Montserrat', sans-serif; font-weight: 500; transition: background 0.3s; }
  .btn-add:hover { background: var(--gold-light); }

  /* Always-visible Add to Cart button below each book card */
  .btn-add-card { width: 100%; max-width: 100%; margin-top: 0.6rem; font-family: 'Montserrat', sans-serif; font-size: 0.54rem; letter-spacing: 0.18em; text-transform: uppercase; padding: 0.55rem 0.4rem; background: transparent; color: var(--gold); border: 1px solid rgba(201,168,76,0.4); cursor: pointer; font-weight: 500; transition: all 0.25s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .btn-add-card:hover { background: var(--gold); color: var(--bg); border-color: var(--gold); }
  .btn-add-card:active { transform: scale(0.98); }
  html[data-theme="light"] .btn-add-card { color: var(--gold); border-color: rgba(138,106,31,0.4); }
  html[data-theme="light"] .btn-add-card:hover { background: var(--gold); color: #fff; }

  /* "NEW" arrival ribbon */
  .new-badge { position: absolute; top: 8px; left: 8px; z-index: 5; background: linear-gradient(135deg, #d4584c, #b94236); color: #fff; font-size: 0.55rem; letter-spacing: 0.2em; font-weight: 600; padding: 0.3rem 0.6rem; font-family: 'Montserrat', sans-serif; box-shadow: 0 4px 10px rgba(185,66,54,0.45); animation: newPulse 2.4s ease-in-out infinite; }
  @keyframes newPulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.06); } }
  .book-name { font-family: 'Cormorant Garamond', serif; font-size: 0.92rem; font-weight: 400; color: var(--cream); margin-bottom: 0.2rem; line-height: 1.25; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; min-height:2.3em; }
  .book-author { font-size: 0.58rem; color: var(--cream-dim); letter-spacing: 0.08em; margin-bottom: 0.4rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .book-meta { display: flex; justify-content: space-between; align-items: baseline; gap:0.4rem; }
  .book-price { font-family: 'Cormorant Garamond', serif; font-size: 1rem; color: var(--gold); font-weight: 600; white-space:nowrap; }
  .book-orig-price { font-size: 0.65rem; color: var(--cream-dim); text-decoration: line-through; margin-left: 0.3rem; }
  .book-category { font-size: 0.5rem; letter-spacing: 0.15em; text-transform: uppercase; color: var(--gold-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:60%; }

  /* Wishlist button on book cards */
  .wish-btn { position:absolute; top:0.5rem; right:0.5rem; background:rgba(13,11,8,0.7); border:none; color:var(--cream-dim); font-size:1rem; width:30px; height:30px; cursor:pointer; display:flex; align-items:center; justify-content:center; opacity:0; transition:opacity 0.2s; z-index:2; border-radius:0; }
  .book-card:hover .wish-btn { opacity:1; }
  .wish-btn.wishlisted { opacity:1; color:#e05050; }
  .wish-btn:hover { color:#e05050; }

  /* Pincode section */
  .pincode-section { background:var(--bg2); border-top:1px solid var(--border); padding:4rem 6rem; }
  .pincode-row { display:flex; gap:1rem; align-items:stretch; max-width:500px; margin-top:2rem; }
  .pincode-input { flex:1; background:var(--bg3); border:1px solid var(--border); color:var(--cream); padding:0.85rem 1.2rem; font-family:'Montserrat',sans-serif; font-size:0.82rem; outline:none; letter-spacing:0.1em; }
  .pincode-input:focus { border-color:var(--gold-dim); }
  .pincode-btn { font-family:'Montserrat',sans-serif; font-size:0.62rem; letter-spacing:0.2em; text-transform:uppercase; padding:0.85rem 1.6rem; background:var(--gold); color:var(--bg); border:none; cursor:pointer; font-weight:500; white-space:nowrap; }
  .pincode-result { margin-top:0.8rem; font-size:0.78rem; min-height:1.4em; }

  /* Load more */
  .load-more-wrap { text-align: center; margin-top: 3.5rem; }
  .btn-load-more { font-family: 'Montserrat', sans-serif; font-size: 0.62rem; letter-spacing: 0.22em; text-transform: uppercase; padding: 0.9rem 2.4rem; border: 1px solid var(--gold-dim); color: var(--gold); background: transparent; cursor: pointer; transition: all 0.3s; }
  .btn-load-more:hover { background: var(--gold); color: var(--bg); }
  .books-count { font-size: 0.62rem; color: var(--cream-dim); letter-spacing: 0.1em; margin-top: 1rem; }

  /* Search bar */
  .search-wrap { margin-bottom: 2rem; max-width: 760px; }
  .search-box { position: relative; display: flex; align-items: center; background: var(--bg3); border: 1px solid var(--border); transition: border-color 0.25s, box-shadow 0.25s; }
  .search-box:focus-within { border-color: var(--gold); box-shadow: 0 0 0 3px rgba(201,168,76,0.12); }
  .search-icon { position: absolute; left: 1rem; color: var(--gold); font-size: 0.9rem; opacity: 0.9; pointer-events: none; }
  .search-input { width: 100%; background: transparent; border: 0; color: var(--cream); padding: 0.95rem 3rem 0.95rem 2.7rem; font-family: 'Montserrat', sans-serif; font-size: 0.86rem; outline: none; transition: border-color 0.3s; letter-spacing: 0.02em; }
  .search-input::placeholder { color: var(--cream-dim); }
  .search-clear { position: absolute; right: 0.45rem; width: 34px; height: 34px; border: 0; background: transparent; color: var(--cream-dim); cursor: pointer; font-size: 1.15rem; line-height: 1; display: none; align-items: center; justify-content: center; }
  .search-clear.show { display: inline-flex; }
  .search-clear:hover { color: var(--gold); }
  .search-hints { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-top: 0.75rem; }
  .search-chip { border: 1px solid var(--border); background: transparent; color: var(--cream-dim); font-family: 'Montserrat', sans-serif; font-size: 0.58rem; letter-spacing: 0.12em; text-transform: uppercase; padding: 0.42rem 0.7rem; cursor: pointer; }
  .search-chip:hover { color: var(--gold); border-color: var(--gold-dim); }
  .search-status { min-height: 1.2rem; margin-top: 0.65rem; color: var(--cream-dim); font-size: 0.66rem; letter-spacing: 0.08em; }

  /* SEARCH OVERLAY */
  .srch-overlay{position:fixed;inset:0;z-index:9800;pointer-events:none;opacity:0;transition:opacity 0.2s;}
  .srch-overlay.open{pointer-events:all;opacity:1;}
  .srch-backdrop{position:absolute;inset:0;background:rgba(0,0,0,0.62);backdrop-filter:blur(4px);}
  .srch-panel{position:absolute;top:0;left:0;right:0;background:var(--bg);border-bottom:1px solid var(--border);padding:4.8rem 2rem 1.6rem;transform:translateY(-8px);transition:transform 0.25s cubic-bezier(0.22,1,0.36,1);box-shadow:0 24px 60px rgba(0,0,0,0.5);}
  .srch-overlay.open .srch-panel{transform:translateY(0);}
  .srch-inner{max-width:760px;margin:0 auto;}
  .srch-row{position:relative;display:flex;align-items:center;background:var(--bg3);border:1px solid var(--gold-dim);transition:border-color 0.2s,box-shadow 0.2s;}
  .srch-row:focus-within{border-color:var(--gold);box-shadow:0 0 0 3px rgba(201,168,76,0.15);}
  .srch-ic{position:absolute;left:1rem;color:var(--gold);font-size:1.05rem;pointer-events:none;}
  .srch-input{flex:1;background:transparent;border:0;color:var(--cream);padding:1rem 3rem 1rem 3rem;font-family:'Montserrat',sans-serif;font-size:0.9rem;outline:none;letter-spacing:0.02em;}
  .srch-input::placeholder{color:var(--cream-dim);}
  .srch-cls{background:none;border:none;color:var(--cream-dim);cursor:pointer;font-size:1.4rem;padding:0.9rem 1rem;line-height:1;transition:color 0.2s;}
  .srch-cls:hover{color:var(--gold);}
  .srch-chips{display:flex;flex-wrap:wrap;gap:0.45rem;margin-top:0.85rem;}

  /* COLLECTIONS */
  .collections { background: var(--bg); }
  .collections-grid { display: grid; grid-template-columns: 2fr 1fr 1fr; grid-template-rows: auto auto; gap: 1.5rem; margin-top: 3.5rem; }
  .coll-card { position: relative; overflow: hidden; cursor: pointer; border: 1px solid var(--border); }
  .coll-card.large { grid-row: span 2; }
  .coll-inner { height: 100%; min-height: 200px; display: flex; flex-direction: column; justify-content: flex-end; padding: 2rem; position: relative; transition: transform 0.5s ease; }
  .coll-card.large .coll-inner { min-height: 460px; }
  .coll-card:hover .coll-inner { transform: scale(1.03); }
  .coll-bg { position: absolute; inset: 0; transition: filter 0.4s; }
  .coll-card:hover .coll-bg { filter: brightness(0.7); }
  .coll-bg-1{background:linear-gradient(135deg,#1a0500 0%,#3d1200 40%,#1a0a02 100%)}.coll-bg-2{background:linear-gradient(135deg,#001020 0%,#002040 50%,#001828 100%)}.coll-bg-3{background:linear-gradient(135deg,#100015 0%,#2a0050 50%,#150030 100%)}.coll-bg-4{background:linear-gradient(135deg,#001510 0%,#003520 50%,#001a15 100%)}.coll-bg-5{background:linear-gradient(135deg,#150a00 0%,#352000 50%,#1a0f00 100%)}
  .coll-overlay { position: absolute; inset: 0; background: linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 60%); }
  .coll-content { position: relative; z-index: 2; }
  .coll-count { font-size: 0.55rem; letter-spacing: 0.3em; text-transform: uppercase; color: var(--gold); margin-bottom: 0.4rem; }
  .coll-name { font-family: 'Cormorant Garamond', serif; font-size: 1.35rem; font-weight: 400; color: var(--white); line-height: 1.2; }
  .coll-card.large .coll-name { font-size: 2rem; }
  .coll-desc { font-size: 0.7rem; color: var(--cream-dim); margin-top: 0.5rem; line-height: 1.6; display: none; }
  .coll-card.large .coll-desc { display: block; }
  .coll-thumb { position: absolute; top: 1.4rem; right: 1.4rem; width: 72px; aspect-ratio: 2/3; object-fit: cover; border: 1px solid rgba(201,168,76,0.35); box-shadow: 0 8px 22px rgba(0,0,0,0.5); transform: rotate(4deg); transition: transform 0.4s; z-index: 3; background: #1a0a00; }
  .coll-card.large .coll-thumb { width: 130px; top: 2rem; right: 2rem; }
  .coll-card:hover .coll-thumb { transform: rotate(0) scale(1.05); }
  .coll-cta { font-size: 0.58rem; letter-spacing: 0.22em; text-transform: uppercase; color: var(--gold); margin-top: 1rem; opacity: 0; transform: translateY(6px); transition: all 0.3s; font-family: 'Montserrat',sans-serif; }
  .coll-card:hover .coll-cta { opacity: 1; transform: translateY(0); }
  .coll-card.large .coll-cta { opacity: 1; transform: none; }

  /* EDITORIAL */
  .editorial { background: var(--bg3); padding: 0; display: grid; grid-template-columns: 1fr 1fr; min-height: 500px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
  .editorial-visual { background: linear-gradient(135deg,#0d0500,#2a0a00,#1a0800); display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden; padding: 4rem; }
  .editorial-visual::before { content: ''; position: absolute; width: 300px; height: 300px; border-radius: 50%; background: radial-gradient(circle, rgba(201,168,76,0.15) 0%, transparent 70%); top: 50%; left: 50%; transform: translate(-50%, -50%); }
  .quote-mark { font-family: 'Cormorant Garamond', serif; font-size: 15rem; color: var(--gold); opacity: 0.08; position: absolute; top: -2rem; left: 2rem; line-height: 1; font-style: italic; }
  .editorial-quote { font-family: 'Cormorant Garamond', serif; font-size: 1.8rem; font-style: italic; color: var(--cream); line-height: 1.5; text-align: center; position: relative; z-index: 2; }
  .editorial-attr { font-size: 0.6rem; letter-spacing: 0.25em; text-transform: uppercase; color: var(--gold); text-align: center; margin-top: 1.2rem; display: block; position: relative; z-index: 2; }
  .editorial-content { padding: 5rem; display: flex; flex-direction: column; justify-content: center; }
  .editorial-content .section-title { margin-bottom: 1.5rem; }
  .editorial-content p { font-size: 0.82rem; color: var(--cream-dim); line-height: 1.9; margin-bottom: 1rem; letter-spacing: 0.03em; }

  /* NEWSLETTER */
  .newsletter { background: var(--bg2); text-align: center; padding: 6rem; border-top: 1px solid var(--border); }
  .newsletter .section-label { justify-content: center; }
  .newsletter .section-label::before { display: none; }
  .newsletter-form { display: flex; gap: 0; max-width: 480px; margin: 2.5rem auto 0; }
  .newsletter-input { flex: 1; background: var(--bg3); border: 1px solid var(--border); border-right: none; color: var(--cream); padding: 0.9rem 1.4rem; font-family: 'Montserrat', sans-serif; font-size: 0.75rem; letter-spacing: 0.05em; outline: none; transition: border-color 0.3s; }
  .newsletter-input::placeholder { color: var(--cream-dim); }
  .newsletter-input:focus { border-color: var(--gold-dim); }
  .btn-subscribe { font-family: 'Montserrat', sans-serif; font-size: 0.6rem; letter-spacing: 0.22em; text-transform: uppercase; padding: 0.9rem 1.8rem; background: var(--gold); color: var(--bg); border: none; cursor: pointer; font-weight: 500; transition: background 0.3s; white-space: nowrap; }
  .btn-subscribe:hover { background: var(--gold-light); }

  /* FOOTER */
  footer { background: var(--bg); padding: 4rem 6rem 2rem; border-top: 1px solid var(--border); }
  .footer-top { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 4rem; margin-bottom: 4rem; }
  .footer-logo { font-family: 'Cormorant Garamond', serif; font-size: 1.8rem; font-weight: 600; color: var(--gold); margin-bottom: 1rem; }
  .footer-logo span { color: var(--cream); font-weight: 300; font-style: italic; }
  .footer-about { font-size: 0.72rem; color: var(--cream-dim); line-height: 1.9; letter-spacing: 0.03em; }
  .footer-col-title { font-size: 0.6rem; letter-spacing: 0.3em; text-transform: uppercase; color: var(--gold); margin-bottom: 1.5rem; }
  .footer-links { list-style: none; display: flex; flex-direction: column; gap: 0.75rem; }
  .footer-links a { font-size: 0.72rem; color: var(--cream-dim); text-decoration: none; transition: color 0.3s; letter-spacing: 0.05em; }
  .footer-links a:hover { color: var(--gold); }
  .footer-bottom { display: flex; justify-content: space-between; align-items: center; padding-top: 2rem; border-top: 1px solid var(--border); }
  .footer-copy { font-size: 0.62rem; color: var(--cream-dim); letter-spacing: 0.12em; }
  .footer-bottom-links { display: flex; gap: 2rem; }
  .footer-bottom-links a { font-size: 0.62rem; color: var(--cream-dim); text-decoration: none; letter-spacing: 0.12em; transition: color 0.3s; }
  .footer-bottom-links a:hover { color: var(--gold); }

  /* ANIMATIONS */
  @keyframes fadeUp { from { opacity: 0; transform: translateY(28px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes revealSection { from { opacity: 0; transform: translateY(22px); } to { opacity: 1; transform: none; } }
  .hero-eyebrow { animation: fadeUp 0.9s cubic-bezier(0.22,1,0.36,1) 0.15s both; }
  .hero-title    { animation: fadeUp 0.9s cubic-bezier(0.22,1,0.36,1) 0.3s both; }
  .hero-sub      { animation: fadeUp 0.9s cubic-bezier(0.22,1,0.36,1) 0.48s both; }
  .hero-ctas     { animation: fadeUp 0.9s cubic-bezier(0.22,1,0.36,1) 0.62s both; }
  .hero-stats    { animation: fadeUp 0.9s cubic-bezier(0.22,1,0.36,1) 0.78s both; }
  /* Scroll-reveal utility */
  .sr { opacity: 0; transform: translateY(22px); transition: opacity 0.7s cubic-bezier(0.22,1,0.36,1), transform 0.7s cubic-bezier(0.22,1,0.36,1); }
  .sr.in { opacity: 1; transform: none; }
  /* Page-load body fade */
  @keyframes bodyFadeIn { from { opacity: 0; } to { opacity: 1; } }
  body { animation: bodyFadeIn 0.4s ease both; }

  /* HORIZONTAL SHELF ROWS */
  .shelves-section { background: var(--bg); padding: 5rem 6rem; border-top: 1px solid var(--border); }
  .shelf-block { margin-bottom: 4rem; }
  .shelf-block:last-child { margin-bottom: 0; }
  .shelf-header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 1.4rem; border-bottom: 1px solid var(--border); padding-bottom: 1rem; }
  .shelf-label { font-size: 0.55rem; letter-spacing: 0.3em; text-transform: uppercase; color: var(--gold); margin-bottom: 0.35rem; }
  .shelf-title { font-family: 'Cormorant Garamond', serif; font-size: 1.8rem; font-weight: 300; color: var(--white); line-height: 1.1; }
  .shelf-title em { font-style: italic; color: var(--gold-light); }
  .shelf-link { font-size: 0.58rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--gold); text-decoration: none; white-space: nowrap; padding: 0.5rem 1rem; border: 1px solid rgba(201,168,76,0.4); transition: all 0.2s; }
  .shelf-link:hover { background: var(--gold); color: var(--bg); }
  .shelf-row { display: flex; gap: 1rem; overflow-x: auto; scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; scrollbar-width: none; padding-bottom: 0.5rem; }
  .shelf-row::-webkit-scrollbar { display: none; }
  .shelf-card { flex: 0 0 155px; scroll-snap-align: start; cursor: pointer; }
  .shelf-card-cover { aspect-ratio: 2/3; background: var(--bg2); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; overflow: hidden; margin-bottom: 0.6rem; transition: border-color 0.25s; }
  .shelf-card:hover .shelf-card-cover { border-color: var(--gold-dim); }
  .shelf-card-cover img { width: 100%; height: 100%; object-fit: contain; display: block; transition: transform 0.35s; }
  .shelf-card:hover .shelf-card-cover img { transform: scale(1.04); }
  .shelf-card-name { font-family: 'Cormorant Garamond', serif; font-size: 0.88rem; color: var(--cream); line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 2.2em; }
  .shelf-card-price { font-size: 0.85rem; color: var(--gold); font-weight: 600; margin-top: 0.25rem; }
  .shelf-card-btn { width: 100%; margin-top: 0.45rem; font-size: 0.5rem; letter-spacing: 0.15em; text-transform: uppercase; padding: 0.52rem 0.25rem; background: transparent; color: var(--gold); border: 1px solid rgba(201,168,76,0.4); cursor: pointer; font-family: 'Montserrat', sans-serif; font-weight: 500; transition: all 0.2s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .shelf-card-btn:hover { background: var(--gold); color: var(--bg); border-color: var(--gold); }
  @media(max-width:1100px) { .shelves-section { padding: 5rem 2.5rem; } }
  @media(max-width:600px) { .shelves-section { padding: 3.2rem 0.85rem; } .shelf-card { flex: 0 0 128px; } .shelf-title { font-size: 1.4rem; } }

  /* ALL CATEGORIES */
  .all-categories { background: var(--bg3); border-top: 1px solid var(--border); }
  .cat-search-wrap { margin: 2rem 0 2rem; }
  .cat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 0.75rem; }
  .cat-card {
    display: flex; flex-direction: column; padding: 1rem 1.1rem;
    border: 1px solid var(--border); background: var(--bg2);
    cursor: pointer; transition: all 0.25s; text-decoration: none; color: inherit;
  }
  .cat-card:hover { border-color: var(--gold); background: rgba(201,168,76,0.06); transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,0.3); }
  .cat-card.active-cat { border-color: var(--gold); background: rgba(201,168,76,0.1); }
  .cat-icon { font-size: 1.6rem; margin-bottom: 0.5rem; line-height: 1; }
  .cat-name { font-family: 'Montserrat', sans-serif; font-size: 0.72rem; font-weight: 500; color: var(--cream); line-height: 1.3; }
  .cat-count { font-size: 0.5rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--gold-dim); margin-top: 0.25rem; }
  @media(max-width:600px) { .cat-grid { grid-template-columns: repeat(3, 1fr); gap: 0.6rem; } .cat-card { padding: 0.75rem 0.75rem; } .cat-icon { font-size: 1.3rem; } .cat-name { font-size: 0.65rem; } }

  /* PRODUCT MODAL */
  .prod-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.75); z-index:600; opacity:0; pointer-events:none; transition:opacity 0.3s; backdrop-filter:blur(4px); }
  .prod-overlay.show { opacity:1; pointer-events:all; }
  .prod-modal { position:fixed; inset:0; z-index:700; display:flex; align-items:center; justify-content:center; padding:2rem; pointer-events:none; opacity:0; transform:translateY(24px); transition:opacity 0.3s, transform 0.3s; }
  .prod-modal.show { opacity:1; transform:translateY(0); pointer-events:all; }
  .prod-close { position:absolute; top:1.2rem; right:1.4rem; background:none; border:none; color:var(--cream-dim); font-size:1.4rem; cursor:pointer; z-index:2; transition:color 0.2s; line-height:1; }
  .prod-close:hover { color:var(--gold); }
  .prod-inner { background:var(--bg3); border:1px solid var(--border); width:min(860px,100%); max-height:90vh; overflow-y:auto; display:grid; grid-template-columns:1fr 1.4fr; position:relative; }
  .prod-img-col { background:var(--bg2); display:flex; align-items:center; justify-content:center; min-height:340px; padding:2.5rem; }
  .prod-img-col img { max-height:420px; max-width:100%; object-fit:contain; box-shadow:0 20px 60px rgba(0,0,0,0.5); }
  .prod-img-placeholder { width:180px; height:260px; background:linear-gradient(135deg,#1a0a00,#3a1500); }
  .prod-info { padding:2.8rem 2.4rem; display:flex; flex-direction:column; gap:1rem; overflow-y:auto; }
  .prod-cat { font-size:0.55rem; letter-spacing:0.3em; text-transform:uppercase; color:var(--gold); }
  .prod-title { font-family:'Cormorant Garamond',serif; font-size:1.9rem; font-weight:400; color:var(--white); line-height:1.2; }
  .prod-author { font-size:0.72rem; color:var(--cream-dim); letter-spacing:0.1em; }
  .prod-price-row { display:flex; align-items:baseline; gap:0.8rem; margin-top:0.3rem; }
  .prod-price { font-family:'Cormorant Garamond',serif; font-size:2rem; color:var(--gold); font-weight:600; }
  .prod-orig { font-size:0.9rem; color:var(--cream-dim); text-decoration:line-through; }
  .prod-saving { font-size:0.65rem; letter-spacing:0.1em; color:#6dbf6d; background:rgba(109,191,109,0.1); padding:0.25rem 0.6rem; }
  .prod-desc { font-size:0.78rem; color:var(--cream-dim); line-height:1.9; letter-spacing:0.03em; border-top:1px solid var(--border); padding-top:1rem; }
  .prod-actions { display:flex; gap:0.8rem; margin-top:auto; padding-top:1rem; border-top:1px solid var(--border); }
  .prod-btn-cart { flex:1; font-family:'Montserrat',sans-serif; font-size:0.62rem; letter-spacing:0.22em; text-transform:uppercase; padding:0.9rem 1rem; background:var(--gold); color:var(--bg); border:none; cursor:pointer; font-weight:500; transition:background 0.3s; }
  .prod-btn-cart:hover { background:var(--gold-light); }
  .prod-btn-share { font-family:'Montserrat',sans-serif; font-size:0.62rem; letter-spacing:0.18em; text-transform:uppercase; padding:0.9rem 1.2rem; background:transparent; color:var(--cream-dim); border:1px solid var(--border); cursor:pointer; transition:all 0.3s; }
  .prod-btn-share:hover { border-color:var(--gold-dim); color:var(--gold); }
  @media (max-width:640px) { .prod-inner { grid-template-columns:1fr; } .prod-img-col { min-height:220px; } }

  /* CART SIDEBAR */
  .cart-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9990; opacity:0; pointer-events:none; transition:opacity 0.35s; }
  .cart-overlay.show { opacity:1; pointer-events:all; }
  .cart-sidebar { position:fixed; top:0; right:0; bottom:0; width:min(420px,100vw); background:var(--bg3); border-left:1px solid var(--border); z-index:10001; transform:translateX(100%); transition:transform 0.35s cubic-bezier(0.4,0,0.2,1); display:flex; flex-direction:column; }
  .cart-sidebar.open { transform:translateX(0); }
  .cart-header { display:flex; justify-content:space-between; align-items:center; padding:1.6rem 1.8rem; border-bottom:1px solid var(--border); }
  .cart-title { font-family:'Cormorant Garamond',serif; font-size:1.4rem; font-weight:400; color:var(--white); }
  .cart-close { background:none; border:none; color:var(--cream-dim); font-size:1.3rem; cursor:pointer; padding:0.2rem 0.4rem; transition:color 0.2s; }
  .cart-close:hover { color:var(--gold); }
  .cart-body { flex:1; overflow-y:auto; padding:1.2rem 1.8rem; }
  .cart-empty { text-align:center; padding:4rem 1rem; color:var(--cream-dim); font-size:0.78rem; letter-spacing:0.08em; }
  .cart-empty-icon { font-size:2.5rem; margin-bottom:1rem; opacity:0.3; }
  .cart-item { display:flex; gap:1rem; padding:1.2rem 0; border-bottom:1px solid var(--border); }
  .cart-item-img { width:64px; flex-shrink:0; aspect-ratio:2/3; background:var(--bg2); overflow:hidden; }
  .cart-item-img img { width:100%; height:100%; object-fit:cover; }
  .cart-item-img-placeholder { width:100%; height:100%; background:linear-gradient(135deg,#1a0a00,#3a1500); }
  .cart-item-info { flex:1; min-width:0; }
  .cart-item-title { font-family:'Cormorant Garamond',serif; font-size:0.95rem; color:var(--cream); line-height:1.3; margin-bottom:0.2rem; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
  .cart-item-author { font-size:0.6rem; color:var(--cream-dim); letter-spacing:0.08em; margin-bottom:0.4rem; }
  .cart-item-price { font-family:'Cormorant Garamond',serif; font-size:1rem; color:var(--gold); margin-bottom:0.5rem; }
  .cart-item-controls { display:flex; align-items:center; gap:0.5rem; }
  .qty-btn { background:var(--bg2); border:1px solid var(--border); color:var(--cream); width:24px; height:24px; cursor:pointer; font-size:0.9rem; display:flex; align-items:center; justify-content:center; transition:all 0.2s; }
  .qty-btn:hover { background:var(--gold); color:var(--bg); border-color:var(--gold); }
  .qty-num { font-size:0.78rem; color:var(--cream); min-width:20px; text-align:center; }
  .cart-remove { background:none; border:none; color:var(--cream-dim); font-size:0.6rem; letter-spacing:0.12em; cursor:pointer; text-transform:uppercase; margin-left:0.5rem; transition:color 0.2s; }
  .cart-remove:hover { color:#e05a5a; }
  .cart-footer { padding:1.4rem 1.8rem; border-top:1px solid var(--border); display:flex; flex-direction:column; gap:0.8rem; }
  .cart-total-row { display:flex; justify-content:space-between; align-items:baseline; }
  .cart-total-label { font-size:0.6rem; letter-spacing:0.22em; text-transform:uppercase; color:var(--cream-dim); }
  .cart-total-amount { font-family:'Cormorant Garamond',serif; font-size:1.5rem; color:var(--gold); font-weight:600; }
  .btn-checkout { width:100%; font-family:'Montserrat',sans-serif; font-size:0.65rem; letter-spacing:0.25em; text-transform:uppercase; padding:1rem; background:var(--gold); color:var(--bg); border:none; cursor:pointer; font-weight:500; transition:all 0.3s; }
  .btn-checkout:hover { background:var(--gold-light); }
  .cart-badge { background:var(--gold); color:var(--bg); border-radius:50%; width:18px; height:18px; font-size:0.55rem; font-weight:500; display:inline-flex; align-items:center; justify-content:center; position:absolute; top:-6px; right:-8px; }
  .nav-cart-wrap { position:relative; }

  /* RESPONSIVE */
  @media (max-width: 1100px) {
    nav { padding: 1.2rem 2rem; }
    .nav-links { display: none; }
    .hero { grid-template-columns: 1fr; }
    .hero-left { padding: 8rem 2.5rem 2rem; }
    .hero-right { padding:1rem 2.5rem 4rem; }
    .hero-cover-wall { grid-template-columns:repeat(4,minmax(78px,1fr)); gap:0.8rem; transform:none; }
    .hero-note { display:none; }
    section { padding: 5rem 2.5rem; }
    .books-grid { grid-template-columns: repeat(2, 1fr); }
    .collections-grid { grid-template-columns: 1fr 1fr; }
    .coll-card.large { grid-column: span 2; }
    .editorial { grid-template-columns: 1fr; }
    .footer-top { grid-template-columns: 1fr 1fr; gap: 2.5rem; }
    footer { padding: 3rem 2.5rem 1.5rem; }
    .newsletter { padding: 4rem 2.5rem; }
  }
  @media (max-width: 600px) {
    nav { padding: 0.65rem 0.85rem 0.55rem; overflow: visible; flex-wrap: wrap; gap: 0.35rem 0.65rem; background: rgba(250,247,242,0.97); }
    html:not([data-theme="light"]) nav { background: rgba(13,11,8,0.97); }
    .nav-links { order: 3; display: flex; width: 100%; gap: 0.55rem; overflow-x: auto; -webkit-overflow-scrolling: touch; padding: 0.35rem 0 0.15rem; scrollbar-width: none; }
    .nav-links::-webkit-scrollbar { display: none; }
    .nav-links li { flex: 0 0 auto; }
    .nav-links a { display: inline-flex; min-height: 32px; align-items: center; padding: 0 0.58rem; border: 1px solid var(--border); background: rgba(201,168,76,0.05); font-size: 0.52rem; letter-spacing: 0.13em; white-space: nowrap; }
    .nav-dropdown-trigger::after, .nav-dropdown { display: none; }
    .nav-actions { gap: 0.7rem; min-width: 0; }
    .nav-actions .btn-nav, .nav-actions .nav-cart-wrap { display: none; }
    .theme-toggle { width: 34px; height: 34px; margin-right: 0; flex: 0 0 auto; }
    .nav-icon { flex: 0 0 44px; width:44px; height:44px; display:inline-flex; align-items:center; justify-content:center; font-size:1.18rem; }
    .nav-search-btn { flex: 0 0 auto; min-width: 86px; height: 42px; border: 1px solid var(--border); padding: 0 0.75rem; gap: 0.42rem; font-family: 'Montserrat', sans-serif; color: var(--gold); background: rgba(201,168,76,0.06); }
    .nav-search-btn span:first-child { font-size: 1rem; line-height: 1; }
    .nav-search-label { display: inline; font-size: 0.56rem; letter-spacing: 0.14em; text-transform: uppercase; }
    section { padding: 3.2rem 0.85rem; overflow-x: hidden; }
    .featured-header { display: block; margin-bottom: 1.8rem; }
    .tabs { overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 0.2rem; }
    .tab { flex: 0 0 auto; padding-left: 0.65rem; padding-right: 0.65rem; letter-spacing: 0.12em; }
    .books-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.95rem 0.7rem; }
    .book-cover { max-height: none; width: 100%; margin-bottom: 0.65rem; }
    .book-meta { display: block; }
    .book-category { display: block; max-width: 100%; margin-top: 0.25rem; }
    .book-price { display: inline-block; max-width: 100%; }
    .book-orig-price { margin-left: 0.25rem; }
    .btn-add-card { font-size: 0.5rem; letter-spacing: 0.14em; padding: 0.62rem 0.25rem; }
    .search-wrap { max-width: none; margin-bottom: 1.4rem; }
    .search-box { min-height:54px; }
    .search-icon { left:0.95rem; font-size:1.05rem; }
    .search-input { font-size:16px; padding:1rem 3.5rem 1rem 2.75rem; min-height:54px; }
    .search-clear { width:44px; height:44px; right:0.25rem; font-size:1.3rem; }
    .search-hints { overflow-x: auto; flex-wrap: nowrap; -webkit-overflow-scrolling: touch; padding-bottom: 0.15rem; }
    .search-chip { flex: 0 0 auto; }
    .hero { min-height:auto; }
    .hero-title { font-size:clamp(2.45rem,13vw,3.45rem); line-height:1.04; margin-bottom:1.3rem; }
    .hero-sub { width:auto; max-width:330px; margin-bottom:1.55rem; font-size:0.76rem; line-height:1.75; }
    .hero-ctas { flex-direction:column; align-items:stretch; }
    .hero-eyebrow,.hero-title,.hero-sub,.hero-ctas,.hero-stats{animation:none;opacity:1;transform:none}
    .hero-stats { display:none; }
    .stat-num { font-size:1.35rem; }
    .stat-label { font-size:0.48rem; }
    .hero-left { padding:7.4rem 1.2rem 1rem; max-width:100vw; overflow:hidden; }
    .hero-right { padding:0.5rem 1.2rem 3rem; max-width:100vw; }
    .hero-cover-wall { grid-template-columns:repeat(2,1fr); gap:0.75rem; width:calc(100vw - 2.4rem); max-width:calc(100vw - 2.4rem); }
    .hero-cover-card:nth-child(2),.hero-cover-card:nth-child(5),.hero-cover-card:nth-child(4),.hero-cover-card:nth-child(7){transform:none}
    .hero-cover-card:nth-child(7){display:none}
  }
  /* Promo banner above nav */
  .promo-banner{background:linear-gradient(90deg,#1a1410,#2a1f15,#1a1410);border-bottom:1px solid rgba(201,168,76,0.25);padding:0.55rem 1rem;text-align:center;font-size:0.66rem;letter-spacing:0.12em;color:#f0e8d8;font-family:'Montserrat',sans-serif;position:relative;z-index:200}
  .promo-banner strong{color:#c9a84c;font-weight:600;letter-spacing:0.18em}
  .promo-banner code{background:rgba(201,168,76,0.18);color:#c9a84c;padding:0.15rem 0.55rem;border:1px dashed rgba(201,168,76,0.5);font-family:'Montserrat',sans-serif;font-size:0.62rem;letter-spacing:0.15em;margin-left:0.5rem}
  @media(max-width:780px){.promo-banner{font-size:0.56rem;padding:0.4rem 0.7rem;letter-spacing:0.05em;}}
  @media(max-width:780px){
    .hero-title { font-size:clamp(2.45rem,13vw,3.7rem); line-height:1.04; margin-bottom:1.3rem; }
    .hero-sub { width:calc(100vw - 2.4rem); max-width:calc(100vw - 2.4rem); margin-bottom:1.55rem; font-size:0.76rem; line-height:1.75; }
    .hero-ctas { flex-direction:column; align-items:stretch; }
    .hero-stats { display:none; }
    .hero-eyebrow,.hero-title,.hero-sub,.hero-ctas,.hero-stats{animation:none;opacity:1;transform:none}
    .hero-left { padding:7.4rem 1.2rem 1rem; max-width:100vw; overflow:hidden; }
    .hero-right { padding:0.5rem 1.2rem 3rem; max-width:100vw; justify-content:flex-start; }
    .hero-cover-wall { grid-template-columns:repeat(2,1fr); gap:0.75rem; width:360px; max-width:calc(100vw - 2.4rem); transform:none; }
    .hero-cover-card:nth-child(2),.hero-cover-card:nth-child(5),.hero-cover-card:nth-child(4),.hero-cover-card:nth-child(7){transform:none}
    .hero-cover-card:nth-child(7){display:none}
  }

  /* WhatsApp floating button */
  .wa-float{position:fixed;bottom:22px;left:22px;width:54px;height:54px;border-radius:50%;background:#25d366;color:#fff;display:flex;align-items:center;justify-content:center;font-size:1.7rem;box-shadow:0 6px 20px rgba(37,211,102,0.45);z-index:250;cursor:pointer;text-decoration:none;transition:transform 0.2s,box-shadow 0.2s;animation:waPulse 2.6s ease-in-out infinite}
  .wa-float:hover{transform:scale(1.08);box-shadow:0 8px 28px rgba(37,211,102,0.6)}
  @keyframes waPulse{0%,100%{box-shadow:0 6px 20px rgba(37,211,102,0.45)}50%{box-shadow:0 6px 28px rgba(37,211,102,0.7),0 0 0 8px rgba(37,211,102,0.15)}}
  @media(max-width:780px){.wa-float{bottom:88px;left:14px;width:46px;height:46px;font-size:1.3rem}}

  /* MOBILE BOTTOM NAV — Home · Orders · Cart (mobile only)
     IMPORTANT: top:auto MUST be set, otherwise the general `nav { top:0 }`
     rule combined with our bottom:0 stretches the bar to full viewport. */
  .mob-nav{display:none}
  @media(max-width:780px){
    .mob-nav{display:flex;position:fixed;top:auto!important;bottom:0;left:0;right:0;height:auto;z-index:9998;background:rgba(13,11,8,0.97);border-top:1px solid rgba(201,168,76,0.25);padding:0.5rem 0 calc(0.5rem + env(safe-area-inset-bottom,0px));backdrop-filter:blur(14px);box-shadow:0 -4px 20px rgba(0,0,0,0.4)}
    body{padding-bottom:64px}
  }
  html[data-theme="light"] .mob-nav{background:rgba(250,247,242,0.97);border-top-color:rgba(138,106,31,0.3)}
  .mob-nav a,.mob-nav button{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:0.45rem 0;background:transparent;border:none;color:var(--cream-dim);font-family:'Montserrat',sans-serif;font-size:0.55rem;letter-spacing:0.12em;text-transform:uppercase;cursor:pointer;text-decoration:none;transition:color 0.2s;position:relative}
  .mob-nav a:hover,.mob-nav button:hover,.mob-nav a:active,.mob-nav button:active{color:var(--gold)}
  .mob-nav .mn-icon{font-size:1.25rem;line-height:1}
  .mob-nav .mn-badge{position:absolute;top:0;right:calc(50% - 18px);background:var(--gold);color:var(--bg);border-radius:50%;width:16px;height:16px;font-size:0.55rem;font-weight:600;display:flex;align-items:center;justify-content:center;letter-spacing:0}

  /* Trust strip — Why Choose Ink & Chai */
  .trust-strip{display:grid;grid-template-columns:repeat(5,1fr);gap:1.5rem;max-width:1200px;margin:0 auto;padding:2.5rem 2rem;border-bottom:1px solid var(--border)}
  .trust-item{display:flex;flex-direction:column;align-items:center;text-align:center;gap:0.5rem}
  .trust-link{text-decoration:none}
  .trust-link:hover .trust-title{color:var(--gold)}
  .trust-icon{font-size:1.6rem;color:var(--gold)}
  .trust-title{font-family:'Cormorant Garamond',serif;font-size:1rem;color:var(--cream);font-weight:500}
  .trust-text{font-size:0.7rem;color:var(--cream-dim);line-height:1.5;letter-spacing:0.03em}
  @media(max-width:980px){.trust-strip{grid-template-columns:repeat(3,1fr)}}
  @media(max-width:780px){.trust-strip{grid-template-columns:repeat(2,1fr);gap:1.2rem;padding:1.8rem 1rem}.trust-title{font-size:0.85rem}.trust-text{font-size:0.62rem}}

</style>
</head>
<body>

<!-- Promo banner -->
<div class="promo-banner" id="promoBanner">
  <strong>☀️ SUMMER SALE</strong> &nbsp;10% OFF on ₹299+ &nbsp;·&nbsp; Code: <code onclick="navigator.clipboard?.writeText('SUMMER10')" title="Click to copy" style="cursor:pointer;">SUMMER10</code> &nbsp;·&nbsp; Ends in: <span id="promoTimer" style="font-weight:600;color:#f0c060;letter-spacing:0.08em;"></span>
</div>

<!-- SUMMER SALE BANNER -->
<section class="summer-sale-banner" id="summerSale">
  <div class="summer-sale-inner">
    <div class="summer-sale-left">
      <div class="sale-eyebrow">☀️ Limited Time &nbsp;·&nbsp; Summer 2026</div>
      <div class="sale-headline">10% Off on All Books<br/><em>₹299 &amp; Above</em></div>
      <div class="sale-code-row" style="margin-top:0.7rem;">
        <span class="sale-code-label">Use code at checkout:</span>
        <span class="sale-code" onclick="navigator.clipboard?.writeText('SUMMER10');this.textContent='✓ Copied!';setTimeout(()=>this.textContent='SUMMER10',2000)" title="Click to copy">SUMMER10</span>
      </div>
    </div>
    <div class="sale-countdown-wrap">
      <div class="sale-countdown-label">Sale ends in</div>
      <div class="sale-countdown" id="saleCountdown"></div>
    </div>
  </div>
</section>

<!-- Floating WhatsApp support button -->
<a class="wa-float" href="https://wa.me/919217175546?text=Hi%20Ink%20%26%20Chai%2C%20I%20have%20a%20question%20about%20a%20book." target="_blank" rel="noopener" title="Chat with us on WhatsApp" aria-label="WhatsApp support">
  <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
</a>

<!-- Mobile bottom nav (mobile only via CSS) -->
<nav class="mob-nav" aria-label="Mobile navigation">
  <a href="/" title="Home"><span class="mn-icon">⌂</span><span>Home</span></a>
  <button onclick="window.IAC ? (IAC.getUser() ? IAC.openAccountModal() : IAC.openAuthModal()) : null" title="Account"><span class="mn-icon">👤</span><span>Account</span></button>
  <button onclick="window.IAC ? IAC.openMyOrders() : null" title="My Orders"><span class="mn-icon">📦</span><span>Orders</span></button>
  <button onclick="openCart()" title="Cart"><span class="mn-icon">🛒</span><span>Cart</span><span class="mn-badge" id="cartBadgeMobile" style="display:none;">0</span></button>
</nav>

<nav>
  <a class="nav-logo" href="/" aria-label="Ink and Chai — home">
    <img class="logo-img logo-dark"  src="/images/logo-light.png" alt="Ink &amp; Chai logo" width="120" height="38"/>
    <img class="logo-img logo-light" src="/images/logo.png"       alt="" width="120" height="38" aria-hidden="true"/>
  </a>
  <ul class="nav-links">
    <li><a href="/self-help-books/">Catalogue</a></li>
    <li><a href="/book-combos/">Collections</a></li>
    <li class="nav-dropdown-menu nav-cat-menu">
      <a class="nav-dropdown-trigger" href="/#categories" aria-haspopup="true">Categories</a>
      <div class="nav-dropdown nav-cat-dropdown" role="menu" aria-label="Book categories">
        NAV_CATEGORIES_PLACEHOLDER
      </div>
    </li>
    <li><a href="/track/">Track Order</a></li>
    <li class="nav-dropdown-menu nav-policy-menu">
      <a class="nav-dropdown-trigger" href="/terms/" aria-haspopup="true">Policies</a>
      <div class="nav-dropdown nav-policy-dropdown" role="menu" aria-label="Store policies">
        <a href="/terms/" role="menuitem"><span>Terms</span></a>
        <a href="/privacy-policy/" role="menuitem"><span>Privacy</span></a>
        <a href="/refund-policy/" role="menuitem"><span>Refund</span></a>
        <a href="/return-policy/" role="menuitem"><span>Returns</span></a>
        <a href="/shipping-policy/" role="menuitem"><span>Shipping</span></a>
      </div>
    </li>
    <li><a href="mailto:support@inkandchai.in">Contact Us</a></li>
  </ul>
  <div class="nav-actions">
    <button class="theme-toggle" onclick="toggleTheme()" title="Toggle light/dark mode" aria-label="Toggle theme"><span class="moon">🌙</span><span class="sun">☀️</span></button>
    <button class="nav-search-btn" type="button" title="Search books" aria-label="Search books" onclick="focusSiteSearch()"><span aria-hidden="true">⌕</span><span class="nav-search-label">Search</span></button>
    <span class="nav-icon" title="Wishlist" onclick="openWishlistModal()">&#9825;<span id="wishBadge" style="display:none;font-size:0.55rem;background:var(--gold);color:var(--bg);border-radius:50%;width:14px;height:14px;display:none;align-items:center;justify-content:center;position:absolute;top:-4px;right:-6px;"></span></span>
    <button class="btn-nav" onclick="window.IAC ? IAC.openMyOrders() : null" style="margin-right:0.3rem;">📦 My Orders</button>
    <button class="btn-nav auth-nav-btn" id="authNavBtnMain" onclick="window.IAC ? IAC.openAuthModal() : null">👤 Sign In</button>
    <div class="nav-cart-wrap">
      <button class="btn-nav" onclick="openCart()" style="cursor:pointer;">Cart</button>
      <span class="cart-badge" id="cartBadge" style="display:none;">0</span>
    </div>
  </div>
</nav>

<!-- SEARCH OVERLAY -->
<div class="srch-overlay" id="srchOverlay" role="dialog" aria-label="Search">
  <div class="srch-backdrop" onclick="closeSiteSearch()"></div>
  <div class="srch-panel">
    <div class="srch-inner">
      <div class="srch-row">
        <span class="srch-ic" aria-hidden="true">⌕</span>
        <input class="srch-input" id="srchInput" type="search" placeholder="Search title, author, ISBN, category…"
               autocomplete="off" oninput="srchType()" onkeydown="srchKey(event)" />
        <button class="srch-cls" onclick="closeSiteSearch()" title="Close search" aria-label="Close">✕</button>
      </div>
      <div class="srch-chips">
        <button class="search-chip" onclick="srchQuick('Ana Huang')">Ana Huang</button>
        <button class="search-chip" onclick="srchQuick('Onyx Storm')">Onyx Storm</button>
        <button class="search-chip" onclick="srchQuick('Freida McFadden')">Freida McFadden</button>
        <button class="search-chip" onclick="srchQuick('Atomic Habits')">Atomic Habits</button>
        <button class="search-chip" onclick="srchQuick('Hindi self help')">Hindi Self Help</button>
        <button class="search-chip" onclick="srchQuick('book combo')">Book Combos</button>
      </div>
    </div>
  </div>
</div>

<!-- CART OVERLAY + SIDEBAR -->
<div class="cart-overlay" id="cartOverlay" onclick="closeCart()"></div>
<div class="cart-sidebar" id="cartSidebar">
  <div class="cart-header">
    <span class="cart-title">Your Cart</span>
    <button class="cart-close" onclick="closeCart()">✕</button>
  </div>
  <div class="cart-body">
    <div class="cart-empty" id="cartEmpty">
      <div class="cart-empty-icon">📚</div>
      <div>Your cart is empty.<br/>Add some books to get started.</div>
    </div>
    <div id="cartItems"></div>
  </div>
  <div class="cart-footer" id="cartFooter" style="display:none;">
    <div class="cart-total-row">
      <span class="cart-total-label">Total</span>
      <span class="cart-total-amount" id="cartTotal">₹ 0</span>
    </div>
    <button class="btn-checkout" onclick="window.location.href='/checkout/'">Buy Now →</button>
  </div>
</div>

<!-- HERO -->
<section class="hero" style="padding:0;">
  <div class="hero-left">
    <div class="hero-eyebrow">Hindi self-help bestsellers</div>
    <h1 class="hero-title">Self-help<br/><em>bestsellers</em><br/>in Hindi.</h1>
    <p class="hero-sub">Read the titles everyone talks about — David Goggins, Ben Horowitz, Daniel Kahneman, Robert Kiyosaki, James Clear, and more — in editions made for Indian readers.</p>
    <div class="hero-ctas">
      <a href="/category/hindi-books/" class="btn-primary">Shop Hindi Editions</a>
      <a href="/bestsellers/" class="btn-ghost">See Bestsellers</a>
    </div>
    <div class="hero-stats">
      <div><div class="stat-num">Hindi</div><div class="stat-label">Self-help focus</div></div>
      <div><div class="stat-num">₹499+</div><div class="stat-label">Free shipping</div></div>
      <div><div class="stat-num">COD</div><div class="stat-label">UPI available</div></div>
    </div>
  </div>
  <div class="hero-right">
    <div class="hero-cover-wall" aria-label="Hindi self-help featured books">
      <a class="hero-cover-card featured" href="/product/can-t-hurt-me-hindi-ME-HI/" data-label="Can't Hurt Me · Hindi">
        <img src="/images/cant-hurt-me-hindi.jpg" alt="Can't Hurt Me Hindi edition" loading="eager" fetchpriority="high"/>
      </a>
      <a class="hero-cover-card" href="/product/never-finished-hindi-ED-HI/" data-label="Never Finished">
        <img src="/images/never-finished-hindi.jpg" alt="Never Finished Hindi edition" loading="eager"/>
      </a>
      <a class="hero-cover-card featured" href="/product/the-hard-thing-about-hard-things-hindi-NG-HI/" data-label="The Hard Thing · Hindi">
        <img src="/images/hard-thing-about-hard-things-hindi.jpg" alt="The Hard Thing About Hard Things Hindi edition" loading="eager"/>
      </a>
      <a class="hero-cover-card" href="/product/thinking-fast-and-slow-hindi-OW-HI/" data-label="Thinking, Fast and Slow">
        <img src="/images/thinking-fast-slow-hindi.jpg" alt="Thinking Fast and Slow Hindi edition" loading="eager"/>
      </a>
      <a class="hero-cover-card" href="/product/hindi-rich-dad-poor-dad-80989/" data-label="Rich Dad Poor Dad">
        <img src="RICH_DAD_HINDI_IMAGE_PLACEHOLDER" alt="Rich Dad Poor Dad Hindi edition" loading="lazy"/>
      </a>
      <a class="hero-cover-card featured" href="/product/hindi-atomic-habits-33309/" data-label="Atomic Habits">
        <img src="ATOMIC_HABITS_HINDI_IMAGE_PLACEHOLDER" alt="Atomic Habits Hindi edition" loading="lazy"/>
      </a>
      <a class="hero-cover-card" href="/product/shakti-ke-48-niyam-the-48-laws-of-power-hindi-28157/" data-label="48 Laws of Power">
        <img src="LAWS_48_HINDI_IMAGE_PLACEHOLDER" alt="48 Laws of Power Hindi edition" loading="lazy"/>
      </a>
    </div>
    <div class="hero-note"><strong>Translated picks:</strong> motivation, money, business, psychology, discipline.</div>
  </div>
</section>

<!-- KING OF GLUTTONY FEATURED BANNER -->
<a class="kog-banner-wrap" href="/product/king-of-gluttony-kings-of-sin-book-6-by-ana-huang-ny-ah/" aria-label="Shop King of Gluttony by Ana Huang — ₹299">
  <div class="kog-banner">
    <!-- Spark particles -->
    <div class="kog-spark kog-spark-1"></div>
    <div class="kog-spark kog-spark-2"></div>
    <div class="kog-spark kog-spark-3"></div>
    <div class="kog-crown">♛</div>
    <!-- Book image (clickable via parent link) -->
    <div class="kog-book-wrap">
      <img src="/images/king-of-gluttony.jpg" alt="King of Gluttony by Ana Huang" width="200" height="300"
           onerror="this.parentElement.style.display='none'" loading="eager" />
    </div>
    <!-- Price tag -->
    <div class="kog-price">299</div>
    <!-- Left content -->
    <div class="kog-content">
      <div class="kog-store-label">Ink &amp; Chai — inkandchai.in</div>
      <div class="kog-series">
        <span class="kog-series-line"></span>
        <span class="kog-series-text">Kings of Sin · Book 6</span>
        <span class="kog-series-line"></span>
      </div>
      <div class="kog-title">King of<br/>Gluttony</div>
      <div class="kog-subtitle">A Dark Romance</div>
      <div class="kog-divider"></div>
      <div class="kog-author">by <strong>Ana Huang</strong></div>
      <div class="kog-bestseller">#1 New York Times Bestselling Author</div>
      <span class="kog-cta">Order Now <span class="kog-cta-arrow">→</span></span>
    </div>
  </div>
</a>

<!-- MARQUEE -->
<div class="marquee-bar">
  <div class="marquee-track">
    <span class="marquee-item">Free delivery on ₹499+ orders <span class="marquee-dot">◆</span></span>
    <span class="marquee-item">Prepaid offers: 10% on ₹499+, 12% on ₹999+, 15% on ₹1499+ <span class="marquee-dot">◆</span></span>
    <span class="marquee-item">Cash on delivery available <span class="marquee-dot">◆</span></span>
    <span class="marquee-item">UPI, cards, and net banking accepted <span class="marquee-dot">◆</span></span>
    <span class="marquee-item">7-day replacement support <span class="marquee-dot">◆</span></span>
    <span class="marquee-item">Free delivery on ₹499+ orders <span class="marquee-dot">◆</span></span>
    <span class="marquee-item">Prepaid offers: 10% on ₹499+, 12% on ₹999+, 15% on ₹1499+ <span class="marquee-dot">◆</span></span>
    <span class="marquee-item">Cash on delivery available <span class="marquee-dot">◆</span></span>
    <span class="marquee-item">UPI, cards, and net banking accepted <span class="marquee-dot">◆</span></span>
    <span class="marquee-item">7-day replacement support <span class="marquee-dot">◆</span></span>
  </div>
</div>

<!-- TRUST STRIP — Why Choose Ink & Chai -->
<section class="trust-strip">
  <div class="trust-item">
    <div class="trust-icon">🚚</div>
    <div class="trust-title">Free Pan-India Shipping</div>
    <div class="trust-text">On all prepaid orders above ₹499. Trusted courier partners.</div>
  </div>
  <div class="trust-item">
    <div class="trust-icon">🛡</div>
    <div class="trust-title">Free Replacement</div>
    <div class="trust-text">Damaged, misprinted, or wrong book? We replace it — no questions asked.</div>
  </div>
  <div class="trust-item">
    <div class="trust-icon">💳</div>
    <div class="trust-title">100% Secure Payments</div>
    <div class="trust-text">UPI · Cards · Net Banking · Cash on Delivery — your choice.</div>
  </div>
  <div class="trust-item">
    <div class="trust-icon">📚</div>
    <div class="trust-title">Genuine Books Only</div>
    <div class="trust-text">Every book sourced directly from publishers. 100% original.</div>
  </div>
  <a class="trust-item trust-link" href="https://www.instagram.com/theinkandchai.in/" target="_blank" rel="noopener">
    <div class="trust-icon">◎</div>
    <div class="trust-title">12.4K Instagram Readers</div>
    <div class="trust-text">Follow @theinkandchai.in for customer highlights, book drops, and unboxings.</div>
  </a>
</section>

<!-- FEATURED BOOKS -->
<section class="featured" id="featured">
  <div class="featured-header">
    <div>
      <div class="section-label">Handpicked for You</div>
      <h2 class="section-title">Trending <em>Bestsellers</em></h2>
      <div class="tabs">
        <button class="tab active" data-tab="All"           onclick="setTab(this)">All</button>
        <button class="tab"        data-tab="Bestsellers"   onclick="setTab(this)">🔥 Bestsellers</button>
        <button class="tab"        data-tab="New"           onclick="setTab(this)">✨ New Arrivals</button>
        <button class="tab"        data-tab="Fiction"       onclick="setTab(this)">Fiction</button>
        <button class="tab"        data-tab="Non-Fiction"   onclick="setTab(this)">Non-Fiction</button>
        <button class="tab"        data-tab="Poetry"        onclick="setTab(this)">Poetry</button>
        <button class="tab"        data-tab="Indian Authors" onclick="setTab(this)">Indian Authors</button>
      </div>
    </div>
    <a href="/self-help-books/" class="btn-ghost" style="margin-bottom:1rem;" id="view-all-link">View self-help books</a>
  </div>

  <div class="search-wrap">
    <div class="search-box">
      <span class="search-icon" aria-hidden="true">⌕</span>
      <input class="search-input" type="search" id="searchInput" placeholder="Search title, author, ISBN, category…" autocomplete="off" oninput="onSearch()" onkeydown="onSearchKey(event)" />
      <button class="search-clear" id="searchClear" type="button" aria-label="Clear search" onclick="clearSearch()">×</button>
    </div>
    <div class="search-hints" aria-label="Popular searches">
      <button class="search-chip" type="button" onclick="quickSearch('king of gluttony')">Ana Huang</button>
      <button class="search-chip" type="button" onclick="quickSearch('onyx storm')">Onyx Storm</button>
      <button class="search-chip" type="button" onclick="quickSearch('the housemaid')">Freida McFadden</button>
      <button class="search-chip" type="button" onclick="quickSearch('cant hurt me hindi')">Can’t Hurt Me Hindi</button>
      <button class="search-chip" type="button" onclick="quickSearch('the hidden hindu')">Hidden Hindu</button>
      <button class="search-chip" type="button" onclick="quickSearch('atomic habits')">Atomic Habits</button>
    </div>
    <div class="search-status" id="searchStatus"></div>
  </div>

  <div class="books-grid" id="booksGrid"></div>

  <div class="load-more-wrap">
    <button class="btn-load-more" id="loadMoreBtn" onclick="loadMore()">Load More</button>
    <div class="books-count" id="booksCount"></div>
  </div>
</section>

<!-- COLLECTIONS -->
<section class="collections" id="collections">
  <div class="section-label">Browse by Theme</div>
  <h2 class="section-title">Curated <em>Collections</em></h2>
  <div class="collections-grid" id="collectionsGrid"></div>
</section>

<!-- HORIZONTAL SHELVES -->
<section class="shelves-section" id="shelves">
  <div class="shelf-block">
    <div class="shelf-header">
      <div>
        <div class="shelf-label">Curated for You</div>
        <div class="shelf-title">Self-Help <em>Bestsellers</em></div>
      </div>
      <a class="shelf-link" href="/category/?name=All%20Self%20Help">View all →</a>
    </div>
    <div class="shelf-row" id="shelfSelfHelp"></div>
  </div>
  <div class="shelf-block">
    <div class="shelf-header">
      <div>
        <div class="shelf-label">Page-Turners</div>
        <div class="shelf-title">Fiction <em>Favourites</em></div>
      </div>
      <a class="shelf-link" href="/category/?name=Fiction">View all →</a>
    </div>
    <div class="shelf-row" id="shelfFiction"></div>
  </div>
  <div class="shelf-block">
    <div class="shelf-header">
      <div>
        <div class="shelf-label">Love &amp; Drama</div>
        <div class="shelf-title">Romance <em>Picks</em></div>
      </div>
      <a class="shelf-link" href="/category/?name=All%20Romance%20Books">View all →</a>
    </div>
    <div class="shelf-row" id="shelfRomance"></div>
  </div>
  <div class="shelf-block">
    <div class="shelf-header">
      <div>
        <div class="shelf-label">Little Readers</div>
        <div class="shelf-title">Books for <em>Kids</em></div>
      </div>
      <a class="shelf-link" href="/category/?name=Kids%20Book">View all →</a>
    </div>
    <div class="shelf-row" id="shelfKids"></div>
  </div>
</section>

<!-- ALL CATEGORIES -->
<section class="all-categories" id="categories">
  <div class="section-label">Every Genre</div>
  <h2 class="section-title">Browse <em>All Categories</em></h2>
  <div class="cat-search-wrap">
    <input class="search-input" type="text" id="catSearch" placeholder="Filter categories…" oninput="filterCats()" />
  </div>
  <div class="cat-grid" id="catGrid"></div>
</section>

<!-- EDITORIAL -->
<div class="editorial">
  <div class="editorial-visual">
    <div class="quote-mark">"</div>
    <div>
      <div class="editorial-quote">A reader lives a thousand lives before he dies. The man who never reads lives only one.</div>
      <span class="editorial-attr">— George R.R. Martin</span>
    </div>
  </div>
  <div class="editorial-content">
    <div class="section-label">Our Story</div>
    <h2 class="section-title">More than just<br/><em>a bookshop</em></h2>
    <p>Ink & Chai was born from a simple belief — that the right book, paired with a warm cup of chai, can change everything. We curate every title with care for readers who love to get lost in words.</p>
    <p>From Indian literary masters to manga, from self-help to rare finds — our catalogue spans 40+ genres with fast pan-India delivery straight to your door.</p>
    <a href="#" class="btn-primary" style="align-self:flex-start; margin-top:1rem;">Our Story</a>
  </div>
</div>

<!-- PINCODE CHECKER -->
<section class="pincode-section" id="check-delivery">
  <div class="section-label">Delivery</div>
  <h2 class="section-title" style="font-size:1.8rem;">Check delivery<br/><em>to your pincode</em></h2>
  <p style="font-size:0.78rem;color:var(--cream-dim);margin-top:0.5rem;">We deliver pan-India via trusted courier partners.</p>
  <div class="pincode-row">
    <input class="pincode-input" id="pincodeInput" type="text" maxlength="6" placeholder="Enter 6-digit pincode"
      oninput="this.value=this.value.replace(/\D/g,'')"
      onkeydown="if(event.key==='Enter')checkPincode()"/>
    <button class="pincode-btn" onclick="checkPincode()">Check →</button>
  </div>
  <div class="pincode-result" id="pincodeResult"></div>
</section>

<!-- NEWSLETTER -->
<section class="newsletter">
  <div class="section-label">Stay in the loop</div>
  <h2 class="section-title" style="margin-bottom:0.5rem;">New arrivals. Rare finds.<br/><em>Every week.</em></h2>
  <p style="font-size:0.78rem;color:var(--cream-dim);letter-spacing:0.04em;">Join readers who get our weekly picks — new arrivals, deals, and chai-approved reads. No spam, ever.</p>
  <form class="newsletter-form" onsubmit="subscribeNewsletter(event);">
    <input class="newsletter-input" id="nlEmail" type="email" placeholder="your@email.com" />
    <button class="btn-subscribe" type="submit">Subscribe</button>
  </form>
  <p id="nlMsg" style="font-size:0.72rem;color:var(--gold-dim);margin-top:0.8rem;min-height:1em;"></p>
</section>

<!-- FOOTER -->
<footer>
  <div class="footer-top">
    <div>
      <div class="footer-logo">Ink &amp;<span> Chai</span></div>
      <p class="footer-about">Books we love, delivered to your door. 2,300+ titles across every genre — fiction, manga, self-help, kids, and more — with pan-India delivery in 2–5 days.</p>
      <div style="margin-top:1.5rem;">
        <div class="footer-col-title">Contact Us</div>
        <p style="font-size:0.72rem;color:var(--cream-dim);line-height:2;letter-spacing:0.03em;">
          📧 <a href="mailto:support@inkandchai.in" style="color:var(--gold);text-decoration:none;">support@inkandchai.in</a><br/>
          💬 <a href="https://wa.me/919217175546" target="_blank" style="color:var(--gold);text-decoration:none;">+91 92171 75546 (WhatsApp)</a><br/>
          📍 New Delhi – 110006
        </p>
      </div>
    </div>
    <div>
      <div class="footer-col-title">Shop</div>
      <ul class="footer-links">
        <li><a href="/self-help-books/">Self-Help Books</a></li>
        <li><a href="/hindi-books/">Hindi Books</a></li>
        <li><a href="/book-combos/">Book Combos</a></li>
        <li><a href="/new-arrivals/">New Arrivals</a></li>
        <li><a href="/bestsellers/">Bestsellers</a></li>
      </ul>
    </div>
    <div>
      <div class="footer-col-title">Help</div>
      <ul class="footer-links">
        <li><a href="/shipping-policy/">Shipping Info</a></li>
        <li><a href="/return-policy/">Returns</a></li>
        <li><a href="/refund-policy/">Refund Policy</a></li>
        <li><a href="mailto:support@inkandchai.in">Contact Us</a></li>
        <li><a href="https://wa.me/919217175546" target="_blank">WhatsApp Support</a></li>
      </ul>
    </div>
    <div>
      <div class="footer-col-title">Policies</div>
      <ul class="footer-links">
        <li><a href="/terms/">Terms &amp; Conditions</a></li>
        <li><a href="/privacy-policy/">Privacy Policy</a></li>
        <li><a href="/refund-policy/">Refund Policy</a></li>
        <li><a href="/return-policy/">Return Policy</a></li>
        <li><a href="/shipping-policy/">Shipping Policy</a></li>
      </ul>
    </div>
  </div>
  <div class="footer-bottom">
    <span class="footer-copy">© 2026 Ink &amp; Chai · New Delhi – 110006 · All rights reserved.</span>
    <div class="footer-bottom-links">
      <a href="/privacy-policy/">Privacy</a>
      <a href="/terms/">Terms</a>
      <a href="mailto:support@inkandchai.in">support@inkandchai.in</a>
    </div>
  </div>
</footer>

<!-- Floating WhatsApp Button -->
<a href="https://wa.me/919217175546" target="_blank" rel="noopener"
   style="position:fixed;bottom:2rem;right:2rem;z-index:9000;
          width:56px;height:56px;border-radius:50%;
          background:#25D366;display:flex;align-items:center;justify-content:center;
          box-shadow:0 4px 20px rgba(37,211,102,0.4);
          transition:transform 0.2s,box-shadow 0.2s;text-decoration:none;"
   onmouseover="this.style.transform='scale(1.1)';this.style.boxShadow='0 6px 28px rgba(37,211,102,0.6)'"
   onmouseout="this.style.transform='scale(1)';this.style.boxShadow='0 4px 20px rgba(37,211,102,0.4)'"
   title="Chat with us on WhatsApp">
  <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="white">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
  </svg>
</a>

<!-- Supabase JS (for user accounts) -->
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
<script>
  window.SUPABASE_URL      = "SUPABASE_URL_PLACEHOLDER";
  window.SUPABASE_ANON_KEY = "SUPABASE_ANON_KEY_PLACEHOLDER";
</script>
<!-- Razorpay SDK -->
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<!-- Razorpay public key (set via env at build time) -->
<script>window.RAZORPAY_KEY_ID = "RAZORPAY_PUB_KEY_PLACEHOLDER";</script>
<!-- Cart, Checkout & Auth -->
<script src="/js/cart.js"></script>
<script src="/js/checkout.js"></script>
<script src="/js/auth.js"></script>

<script>
// ── DATA ──────────────────────────────────────────────────────────────────
const BOOKS = BOOKS_DATA_PLACEHOLDER;

const COLLECTIONS = COLLECTIONS_DATA_PLACEHOLDER;
const ALL_CATS    = ALL_CATS_DATA_PLACEHOLDER;

// ── STATE ─────────────────────────────────────────────────────────────────
const PAGE_SIZE = 16;
let currentTab   = 'All';
let currentQuery = '';
let visibleCount = PAGE_SIZE;
let searchTimer  = null;

function priceToText(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? '₹ ' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '';
}

function applyProductOverride(book, override) {
  if (!book || !override) return;
  if (override.title) book.t = override.title;
  if (override.author) book.a = override.author;
  if (override.category) {
    book.cat = override.category;
    book.tab = override.category;
  }
  if (override.price_inr !== null && override.price_inr !== undefined) book.p = priceToText(override.price_inr);
  if (override.original_price_inr !== null && override.original_price_inr !== undefined) book.op = priceToText(override.original_price_inr);
}

function customProductToBook(product) {
  if (!product || !product.slug || !product.title) return null;
  return {
    t: product.title || '',
    a: product.author || '',
    p: priceToText(product.price_inr),
    op: priceToText(product.original_price_inr),
    img: product.image_url || '/images/og-default.jpg',
    back_img: '',
    url: '/product/' + product.slug + '/',
    slug: product.slug,
    cat: product.category || 'Books',
    tab: product.category || 'Books',
    desc: product.description || '',
    isbn: product.isbn || '',
    pub: product.publisher || 'Ink & Chai',
    n: 1,
    ts: product.updated_at || new Date().toISOString(),
    pdf: '',
    pdf_pages: 0,
    rating: '',
    review_count: '',
    order_badge: '',
    review_image: '',
    review_video: '',
    reviews: [],
    custom: true,
  };
}

async function loadProductOverrides() {
  try {
    const res = await fetch('/.netlify/functions/get-product-overrides', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const bySlug = new Map((data.overrides || []).map(o => [String(o.slug || '').toLowerCase(), o]));
    BOOKS.forEach(book => applyProductOverride(book, bySlug.get(String(book.slug || '').toLowerCase())));
    (data.custom_products || []).forEach(product => {
      const book = customProductToBook(product);
      if (book && !BOOKS.some(existing => String(existing.slug || '').toLowerCase() === String(book.slug).toLowerCase())) {
        BOOKS.unshift(book);
      }
    });
  } catch (err) {
    console.warn('Product overrides unavailable:', err.message);
  }
}

// Trending scores refreshed May 2026 from Amazon.in / Flipkart / Storizen
// India-bestseller data + BookTok/Bookstagram viral signals. Higher score
// = more prominent on the homepage Bestsellers tab.
const TRENDING_PATTERNS = [
  // ── Romantasy + BookTok megasellers (2026 wave) ─────────────────────
  ['onyx storm', 140],                  // Rebecca Yarros book 3 — peak right now
  ['fourth wing', 138],
  ['iron flame', 136],
  ['the thorn queen', 134],             // Sasha Peyton Smith — May 2026 release
  // Ana Huang Kings of Sin — entire series trending in India
  ['king of gluttony', 132],            // newest Kings of Sin (book 6)
  ['king of envy', 130],
  ['king of wrath', 128],
  ['king of pride', 127],
  ['king of greed', 126],
  ['king of sloth', 125],
  ['kings of sin', 124],                // boxset / combo
  // Twisted series (Ana Huang) — backlist still on the chart
  ['twisted love', 122],
  ['twisted games', 120],
  ['twisted hate', 118],
  ['twisted lies', 116],
  // Freida McFadden — thriller queen, "Dear Debbie" 2026 release
  ['dear debbie', 114],
  ['the housemaid is watching', 112],
  ["the housemaid's secret", 111],
  ['the housemaid', 110],
  // Mel Robbins viral self-help
  ['the let them theory', 108],
  ['let them theory', 108],
  // Nora Roberts / Carley Fortune — May 2026 romance
  ['the final target', 104],
  ['our perfect storm', 102],

  // ── Self-help + finance evergreens that still move volume ──────────
  ['atomic habits',                100],
  ['the psychology of money',       98],
  ['rich dad poor dad',             96],
  ['$100m leads',                   94],
  ['100m leads',                    94],
  ['$100m offers',                  92],
  ['100m offers',                   92],
  ["can't hurt me",                 90],
  ['cant hurt me',                  90],
  ['कांट हर्ट मी',                  90],   // Hindi edition
  ['never finished',                88],
  ['नेवर फिनिश्ड',                  88],
  ['the let them',                  86],
  ["don't believe everything you think", 86],
  ['dont believe everything you think',  86],
  ["the wealth money can't buy",    82],   // Robin Sharma 2025/26
  ['inner engineering',             80],   // Sadhguru — perennial in India
  ['the courage to be disliked',    78],
  ['ikigai',                        76],
  ['the subtle art of not giving',  74],

  // ── Indian authors — high demand in India specifically ─────────────
  ['mother mary comes to me',      120],   // Arundhati Roy 2026 release
  ['ghost-eye',                    115],   // Amitav Ghosh 2026
  ['the loneliness of sonia',      112],   // Kiran Desai 2026
  ['the sage who reimagined hinduism', 110],  // Shashi Tharoor 2026
  ['the hidden hindu',             108],   // Akshat Gupta — series huge in tier-2/3
  ['the immortals of meluha',       96],   // Amish Tripathi
  ['the secret of the nagas',       94],
  ['the oath of the vayuputras',    92],
  ['ram chandra',                   90],
  ['mahabharata unravelled',        88],
  ['ramayana unravelled',           86],
  ['ramayana retold',               80],
  ['era of india',                  78],   // Minhaz Merchant 2026

  // ── Hindi-language bestsellers (boost for India-focused store) ──────
  ['hindi atomic habits',           96],
  ['perimnaa',                      70],
  ['मूड बूस्टर',                    68],
  ['सीक्रेट',                       64],
  ['the secret hindi',              62],
  ['rich dad poor dad hindi',       90],
  ['संवाद',                         60],
  ['kya tum mujhse',                58],

  // ── Manga (huge growth in Indian metros) ───────────────────────────
  ['solo leveling',                 86],
  ['one piece',                     82],
  ['jujutsu kaisen',                78],
  ['demon slayer',                  74],
  ['naruto',                        70],
  ['my hero academia',              66],

  // ── Viral classics still selling steadily but no longer "trending" ──
  ['it ends with us',               72],
  ['it starts with us',             68],
  ['the alchemist',                 60],
  ['sapiens',                       58],
  ['homo deus',                     52],
  ['48 laws of power',              60],
  ['shoe dog',                      48],
];

function trendScore(b) {
  const hay = `${b.t || ''} ${b.url || ''}`.toLowerCase().replace(/’/g, "'").replace(/\*/g, '');
  for (const [pattern, score] of TRENDING_PATTERNS) {
    if (hay.includes(pattern)) return score;
  }
  return hay.includes('trending') || hay.includes('bestseller') ? 40 : 0;
}

function editionPenalty(b) {
  const t = String(b.t || '').toLowerCase();
  const cat = String(b.cat || '').toLowerCase();
  let penalty = 0;
  // Combos/sets — push down unless they're explicitly trending combos
  if (t.includes('combo') || t.includes('set of') || t.includes('boxset') || t.includes('box set')) penalty += 10;
  // Preloved / used books — much lower demand than new
  if (t.includes('preloved') || cat.includes('preloved')) penalty += 12;
  // Generic activity / colouring / workbook stuff — drop hard
  if (t.includes('workbook') || t.includes('activity book') || t.includes('colouring') || t.includes('coloring')) penalty += 8;
  // Tie-in editions (movie/tv) — usually backlist clearance
  if (t.includes('movie edition') || t.includes('tv tie-in') || t.includes('film edition')) penalty += 5;
  // Holiday / seasonal collections that age fast
  if (t.includes('christmas special') || t.includes('monsoon special') || t.includes('winter special')) penalty += 6;
  // Generic "99-rupee box" kind of bundles — always low margin & low repeat demand
  if (t.includes('99 box') || t.includes('library box') || t.includes('mystery box')) penalty += 9;
  // Imported reprints with weird suffixes
  if (t.includes('us edition') || t.includes('uk edition') || t.includes('international edition')) penalty += 3;
  // No description = scrape leftovers we can't sell well
  if (!b.desc || (b.desc || '').length < 30) penalty += 4;
  // No image = can't even render — strongly demote
  if (!b.img) penalty += 20;
  return penalty;
}

function homepageRank(a, b) {
  return trendScore(b) - trendScore(a)
    || editionPenalty(a) - editionPenalty(b)
    || (b.n || 0) - (a.n || 0)
    || a.t.localeCompare(b.t);
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[`’‘´]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u0900-\u097f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function searchAliases(text) {
  const aliases = [text];
  const compact = text.replace(/\s+/g, '');
  if (compact && compact !== text) aliases.push(compact);
  const withoutThe = text.replace(/\bthe\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (withoutThe && withoutThe !== text) aliases.push(withoutThe);
  return aliases;
}

function bookSearchDoc(b) {
  if (b._searchDoc) return b._searchDoc;
  const title = normalizeSearchText(b.t);
  const author = normalizeSearchText(b.a);
  const category = normalizeSearchText(b.cat);
  const isbn = normalizeSearchText(b.isbn);
  const publisher = normalizeSearchText(b.pub);
  const desc = normalizeSearchText(b.desc);
  const slug = normalizeSearchText(b.slug || b.url);
  const full = normalizeSearchText([b.t, b.a, b.cat, b.isbn, b.pub, b.desc, b.slug, b.url].join(' '));
  b._searchDoc = { title, author, category, isbn, publisher, desc, slug, full };
  return b._searchDoc;
}

function fuzzyWordHit(word, field) {
  if (!word || word.length < 4 || !field) return false;
  for (const candidate of field.split(' ')) {
    if (Math.abs(candidate.length - word.length) > 1) continue;
    let i = 0, j = 0, edits = 0;
    while (i < word.length && j < candidate.length) {
      if (word[i] === candidate[j]) { i++; j++; continue; }
      edits++;
      if (edits > 1) break;
      if (word.length > candidate.length) i++;
      else if (candidate.length > word.length) j++;
      else { i++; j++; }
    }
    edits += (word.length - i) + (candidate.length - j);
    if (edits <= 1) return true;
  }
  return false;
}

function searchScore(book, rawQuery) {
  const q = normalizeSearchText(rawQuery);
  if (!q) return 0;
  const doc = bookSearchDoc(book);
  const tokens = q.split(' ').filter(Boolean);
  const aliases = searchAliases(q);
  let score = 0;

  if (aliases.some(a => doc.title === a || doc.isbn === a)) score += 900;
  if (aliases.some(a => doc.title.startsWith(a))) score += 620;
  if (aliases.some(a => doc.title.includes(a))) score += 420;
  if (aliases.some(a => doc.author.includes(a))) score += 280;
  if (aliases.some(a => doc.category.includes(a))) score += 150;
  if (aliases.some(a => doc.publisher.includes(a) || doc.slug.includes(a))) score += 80;
  if (aliases.some(a => doc.full.includes(a))) score += 60;

  let matched = 0;
  for (const token of tokens) {
    if (doc.title.split(' ').some(w => w === token)) { score += 95; matched++; continue; }
    if (doc.title.includes(token)) { score += 70; matched++; continue; }
    if (doc.author.includes(token)) { score += 50; matched++; continue; }
    if (doc.isbn.includes(token)) { score += 45; matched++; continue; }
    if (doc.category.includes(token)) { score += 35; matched++; continue; }
    if (doc.full.includes(token)) { score += 16; matched++; continue; }
    if (fuzzyWordHit(token, doc.title) || fuzzyWordHit(token, doc.author)) { score += 10; matched++; }
  }
  if (tokens.length && matched < Math.ceil(tokens.length * 0.7)) return 0;
  if (matched === tokens.length && tokens.length > 1) score += 110;

  score += Math.min(trendScore(book), 120) * 0.35;
  score += book.n ? 12 : 0;
  score -= editionPenalty(book) * 2;
  return score;
}

function filteredBooks() {
  const q = normalizeSearchText(currentQuery);
  const tabFiltered = BOOKS.filter(b => currentTab === 'All'
    || (currentTab === 'New' && b.n === 1)
    || (currentTab === 'Bestsellers' && trendScore(b) > 0)
    || b.tab === currentTab);
  if (!q) return tabFiltered.sort(homepageRank);

  const ranked = BOOKS.map(b => ({ b, score: searchScore(b, q) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || homepageRank(a.b, b.b));
  return ranked.map(x => x.b);
}

function renderBooks() {
  const books = filteredBooks();
  const slice = books.slice(0, visibleCount);
  const grid  = document.getElementById('booksGrid');

  grid.innerHTML = slice.map((b, i) => {
    const wishlisted = window.isWishlisted ? isWishlisted(b.url) : false;
    const priceNum = parseFloat((b.p||'').replace(/[^0-9.]/g,'')) || 0;
    return `
    <div class="book-card" style="cursor:pointer;">
      <div class="book-cover" style="position:relative;" onclick="location.href='/product/${b.slug}/'">
        ${b.n ? '<span class="new-badge">NEW</span>' : ''}
        <img src="${b.img}" alt="${escHtml(b.t)}" loading="lazy"
             onerror="this.style.display='none'" />
        <button class="wish-btn ${wishlisted ? 'wishlisted' : ''}"
          data-url="${escHtml(b.url)}"
          title="${wishlisted ? 'Remove from wishlist' : 'Save to wishlist'}"
          onclick="event.stopPropagation(); if(window.toggleWishlist) toggleWishlist({url:'${escHtml(b.url)}',title:'${escHtml(b.t).replace(/'/g,"\\'")}',img:'${escHtml(b.img)}',price:${priceNum}}); updateWishlistBadge();">
          ${wishlisted ? '♥' : '♡'}
        </button>
      </div>
      <div class="book-name" onclick="location.href='/product/${b.slug}/'">${escHtml(b.t)}</div>
      <div class="book-author" onclick="location.href='/product/${b.slug}/'">${escHtml(b.a || '')}</div>
      <div class="book-meta">
        <span class="book-price">${escHtml(b.p)}${b.op ? `<span class="book-orig-price">${escHtml(b.op)}</span>` : ''}</span>
        <span class="book-category">${escHtml(b.cat)}</span>
      </div>
      <button class="btn-add-card" onclick="event.stopPropagation(); addToCartById(this)"
        data-url="${escHtml(b.url)}"
        data-title="${escHtml(b.t)}"
        data-author="${escHtml(b.a||'')}"
        data-price="${priceNum}"
        data-img="${escHtml(b.img)}">+ Add to Cart</button>
    </div>`;
  }).join('');

  const btn = document.getElementById('loadMoreBtn');
  const info = document.getElementById('booksCount');
  const showing = Math.min(visibleCount, books.length);
  info.textContent = `Showing ${showing} of ${books.length} books`;
  updateSearchStatus(books.length);
  btn.style.display = books.length > visibleCount ? 'inline-block' : 'none';
  btn.onclick = loadMore;
}

function renderCollections() {
  const bgClasses = ['coll-bg-1','coll-bg-2','coll-bg-3','coll-bg-4','coll-bg-5'];
  const descs = [
    'The finest voices from the subcontinent — spanning centuries, languages, and perspectives.',
    'Mindset, habits, and the art of living well.',
    'Magical worlds for young readers of every age.',
    'Anime, graphic novels, and sequential art from East and West.',
    'Epics, gods, and the stories that shaped civilisations.',
  ];
  document.getElementById('collectionsGrid').innerHTML = COLLECTIONS.map((c, i) => `
    <a class="coll-card ${i === 0 ? 'large' : ''}" href="/collection/?id=${encodeURIComponent(c.slug || '')}" style="text-decoration:none;color:inherit;">
      <div class="coll-inner">
        <div class="coll-bg ${bgClasses[i]}"></div>
        <div class="coll-overlay"></div>
        ${c.thumb ? `<img class="coll-thumb" src="${escHtml(c.thumb)}" alt="${escHtml(c.name)}" loading="lazy" onerror="this.style.display='none'"/>` : ''}
        <div class="coll-content">
          <div class="coll-count">${c.count} Titles</div>
          <div class="coll-name">${escHtml(c.name)}</div>
          <div class="coll-desc">${descs[i]}</div>
          <div class="coll-cta">Explore Collection →</div>
        </div>
      </div>
    </a>
  `).join('');
}

// Open a multi-category collection — filter the featured grid to its books
function openCollection(catsEncoded, name) {
  let cats = [];
  try { cats = JSON.parse(decodeURIComponent(catsEncoded)) || []; } catch {}
  const set = new Set(cats.map(c => (c||'').toLowerCase()));
  const matches = BOOKS.filter(b => set.has((b.cat||'').toLowerCase()));
  if (!matches.length) { showToast?.('No books in this collection yet'); return; }

  // Reset other filters
  activeCat = null;
  currentTab = 'All';
  currentQuery = '';
  const si = document.getElementById('searchInput'); if (si) si.value = '';
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.tab[data-tab="All"]')?.classList.add('active');

  // Render
  visibleCount = Math.min(matches.length, 200);
  const grid = document.getElementById('booksGrid');
  grid.innerHTML = matches.slice(0, visibleCount).map(b => `
    <div class="book-card" style="cursor:pointer;">
      <div class="book-cover" onclick="location.href='/product/${b.slug}/'">
        <img src="${b.img}" alt="${escHtml(b.t)}" loading="lazy" onerror="this.style.display='none'" />
        <div class="book-cover-overlay">
          <div class="book-cover-title">${escHtml(b.t)}</div>
        </div>
      </div>
      <div class="book-name" onclick="location.href='/product/${b.slug}/'">${escHtml(b.t)}</div>
      <div class="book-author" onclick="location.href='/product/${b.slug}/'">${escHtml(b.a || '')}</div>
      <div class="book-meta">
        <span class="book-price">${escHtml(b.p)}${b.op ? `<span class="book-orig-price">${escHtml(b.op)}</span>` : ''}</span>
        <span class="book-category">${escHtml(b.cat)}</span>
      </div>
      <button class="btn-add-card" onclick="event.stopPropagation(); addToCartById(this)"
        data-url="${escHtml(b.url)}"
        data-title="${escHtml(b.t)}"
        data-author="${escHtml(b.a||'')}"
        data-price="${(b.p||'').replace(/[^0-9.]/g,'')}"
        data-img="${escHtml(b.img)}">+ Add to Cart</button>
    </div>
  `).join('');
  const info = document.getElementById('booksCount');
  if (info) info.textContent = `Showing ${matches.length} books from ${name}`;
  const btn = document.getElementById('loadMoreBtn');
  if (btn) btn.style.display = 'none';
  document.getElementById('featured').scrollIntoView({ behavior: 'smooth' });
}

// Called by Add to Cart buttons — reads data-* attrs from button element
function addToCartById(btn) {
  addToCart({
    id:     btn.dataset.url,
    title:  btn.dataset.title,
    author: btn.dataset.author || '',
    price:  parseFloat(btn.dataset.price || '0'),
    img:    btn.dataset.img,
    url:    btn.dataset.url,
  });
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function slugifyName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-');
}

// ── CONTROLS ──────────────────────────────────────────────────────────────
function setTab(el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  currentTab   = el.dataset.tab;
  visibleCount = PAGE_SIZE;
  renderBooks();
}

function onSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    currentQuery = document.getElementById('searchInput').value;
    visibleCount = PAGE_SIZE;
    renderBooks();
  }, 90);
  const clear = document.getElementById('searchClear');
  if (clear) clear.classList.toggle('show', !!document.getElementById('searchInput').value.trim());
}

function clearSearch() {
  const input = document.getElementById('searchInput');
  input.value = '';
  currentQuery = '';
  visibleCount = PAGE_SIZE;
  document.getElementById('searchClear')?.classList.remove('show');
  renderBooks();
  input.focus();
}

function focusSiteSearch() {
  const overlay = document.getElementById('srchOverlay');
  if (!overlay) return;
  // Sync current search value into overlay input
  const mainVal = document.getElementById('searchInput')?.value || '';
  const srchIn  = document.getElementById('srchInput');
  if (srchIn) srchIn.value = mainVal;
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => srchIn?.focus(), 60);
}

function closeSiteSearch() {
  document.getElementById('srchOverlay')?.classList.remove('open');
  document.body.style.overflow = '';
}

function srchType() {
  const val = document.getElementById('srchInput')?.value || '';
  const mainInput = document.getElementById('searchInput');
  if (mainInput) mainInput.value = val;
  currentQuery = val;
  visibleCount = PAGE_SIZE;
  renderBooks();
}

function srchKey(e) {
  if (e.key === 'Escape') { closeSiteSearch(); return; }
  if (e.key === 'Enter') {
    closeSiteSearch();
    document.getElementById('featured')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function srchQuick(query) {
  const srchIn = document.getElementById('srchInput');
  if (srchIn) srchIn.value = query;
  srchType();
  closeSiteSearch();
  document.getElementById('featured')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function quickSearch(query) {
  const input = document.getElementById('searchInput');
  input.value = query;
  currentQuery = query;
  visibleCount = PAGE_SIZE;
  document.getElementById('searchClear')?.classList.add('show');
  renderBooks();
  document.getElementById('featured')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function onSearchKey(event) {
  if (event.key === 'Escape') clearSearch();
  if (event.key === 'Enter') {
    currentQuery = document.getElementById('searchInput').value;
    const first = filteredBooks()[0];
    if (first) location.href = `/product/${first.slug}/`;
  }
}

function updateSearchStatus(count) {
  const status = document.getElementById('searchStatus');
  const clear = document.getElementById('searchClear');
  const q = currentQuery.trim();
  if (clear) clear.classList.toggle('show', !!q);
  if (!status) return;
  if (!q) {
    status.textContent = 'Search across title, author, ISBN, category, and Hindi editions.';
  } else if (count) {
    status.textContent = `${count} match${count === 1 ? '' : 'es'} for “${q}”`;
  } else {
    status.textContent = `No matches for “${q}”. Try fewer words or author name.`;
  }
}

function loadMore() {
  visibleCount += PAGE_SIZE;
  renderBooks();
  // Animate newly added cards
  const cards = document.querySelectorAll('.book-card');
  cards.forEach((c, i) => {
    if (i >= visibleCount - PAGE_SIZE) {
      c.style.opacity = '0'; c.style.transform = 'translateY(20px)';
      requestAnimationFrame(() => {
        c.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
        c.style.opacity = '1'; c.style.transform = 'translateY(0)';
      });
    }
  });
}

// ── BOOK LOOKUP MAP (keyed by slug) ───────────────────────────────────────
const BOOK_MAP = {};
BOOKS.forEach(b => { BOOK_MAP[b.slug] = b; });


// ── HORIZONTAL SHELF ROWS ─────────────────────────────────────────────────
const CAT_ICONS = {
  'self': '💪', 'fiction': '📖', 'romance': '💕',
  'kid': '🧒', 'child': '🧒', 'business': '💼', 'finance': '💼',
  'hindi': '🇮🇳', 'language': '🌐', 'manga': '🎌', 'comic': '🦸',
  'poetry': '✍️', 'thriller': '🔪', 'mystery': '🕵️',
  'biograph': '👤', 'memoir': '👤', 'history': '🏛️', 'science': '🔬',
  'travel': '✈️', 'cook': '🍳', 'fantasy': '🧙', 'horror': '👻',
  'religion': '🙏', 'spiritual': '🙏', 'art': '🎨',
  'preloved': '♻️', 'new arrival': '✨', 'graphic': '🎨',
};

function getCatIcon(name) {
  const n = (name || '').toLowerCase();
  for (const [k, v] of Object.entries(CAT_ICONS)) { if (n.includes(k)) return v; }
  return '📚';
}

function renderShelf(rowId, filterFn, limit) {
  const books = BOOKS.filter(b => filterFn(b) && b.img).slice(0, limit || 16);
  const el = document.getElementById(rowId);
  if (!el || !books.length) { if (el) el.closest('.shelf-block').style.display='none'; return; }
  el.innerHTML = books.map(b => {
    const price = parseFloat((b.p||'').replace(/[^0-9.]/g,'')) || 0;
    return `<div class="shelf-card" onclick="location.href='/product/${b.slug}/'">
      <div class="shelf-card-cover">
        <img src="${b.img}" alt="${escHtml(b.t)}" loading="lazy" onerror="this.style.display='none'" />
      </div>
      <div class="shelf-card-name">${escHtml(b.t)}</div>
      <div class="shelf-card-price">${escHtml(b.p)}</div>
      <button class="shelf-card-btn" onclick="event.stopPropagation(); addToCartById(this)"
        data-url="${escHtml(b.url)}" data-title="${escHtml(b.t)}"
        data-author="${escHtml(b.a||'')}" data-price="${price}"
        data-img="${escHtml(b.img)}">+ Add to Cart</button>
    </div>`;
  }).join('');
}

function renderShelves() {
  renderShelf('shelfSelfHelp', b => (b.cat||'').toLowerCase().includes('self'), 16);
  renderShelf('shelfFiction',  b => {
    const c = (b.cat||'').toLowerCase();
    return c.includes('fiction') && !c.includes('romance');
  }, 16);
  renderShelf('shelfRomance',  b => (b.cat||'').toLowerCase().includes('romance'), 16);
  renderShelf('shelfKids',     b => {
    const c = (b.cat||'').toLowerCase();
    return c.includes('kid') || c.includes('child');
  }, 16);
}

// ── CATEGORIES ────────────────────────────────────────────────────────────
let activeCat = null;

function renderCats(list) {
  document.getElementById('catGrid').innerHTML = list.map(c => `
    <a class="cat-card" href="/category/${slugifyName(c.name)}/">
      <div class="cat-icon">${getCatIcon(c.name)}</div>
      <div class="cat-name">${escHtml(c.name)}</div>
      <div class="cat-count">${c.count} book${c.count !== 1 ? 's' : ''}</div>
    </a>
  `).join('');
}

function filterCats() {
  const q = document.getElementById('catSearch').value.toLowerCase();
  renderCats(ALL_CATS.filter(c => c.name.toLowerCase().includes(q)));
}

function selectCat(name) {
  activeCat = activeCat === name ? null : name;
  renderCats(ALL_CATS);
  // Apply as search filter in books grid
  if (activeCat) {
    document.getElementById('searchInput').value = '';
    currentQuery = '';
    currentTab   = 'All';
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.tab[data-tab="All"]').classList.add('active');
    // Filter books grid by exact category
    visibleCount = PAGE_SIZE;
    renderBooksForCat(activeCat);
    document.getElementById('featured').scrollIntoView({ behavior: 'smooth' });
  } else {
    visibleCount = PAGE_SIZE;
    renderBooks();
  }
}

function renderBooksForCat(cat) {
  const books = BOOKS.filter(b => b.cat === cat);
  const slice = books.slice(0, visibleCount);
  const grid  = document.getElementById('booksGrid');
  grid.innerHTML = slice.map(b => `
    <div class="book-card" style="cursor:pointer;">
      <div class="book-cover" onclick="location.href='/product/${b.slug}/'" style="position:relative;">
        ${b.n ? '<span class="new-badge">NEW</span>' : ''}
        <img src="${b.img}" alt="${escHtml(b.t)}" loading="lazy" onerror="this.style.display='none'" />
      </div>
      <div class="book-name" onclick="location.href='/product/${b.slug}/'">${escHtml(b.t)}</div>
      <div class="book-author" onclick="location.href='/product/${b.slug}/'">${escHtml(b.a || '')}</div>
      <div class="book-meta">
        <span class="book-price">${escHtml(b.p)}${b.op ? `<span class="book-orig-price">${escHtml(b.op)}</span>` : ''}</span>
        <span class="book-category">${escHtml(b.cat)}</span>
      </div>
      <button class="btn-add-card" onclick="event.stopPropagation(); addToCartById(this)"
        data-url="${escHtml(b.url)}"
        data-title="${escHtml(b.t)}"
        data-author="${escHtml(b.a||'')}"
        data-price="${(b.p||'').replace(/[^0-9.]/g,'')}"
        data-img="${escHtml(b.img)}">+ Add to Cart</button>
    </div>
  `).join('');
  const btn = document.getElementById('loadMoreBtn');
  const info = document.getElementById('booksCount');
  info.textContent = `Showing ${Math.min(visibleCount, books.length)} of ${books.length} books in "${cat}"`;
  btn.style.display = books.length > visibleCount ? 'inline-block' : 'none';
  btn.onclick = () => { visibleCount += PAGE_SIZE; renderBooksForCat(cat); };
}

// ── WISHLIST MODAL ─────────────────────────────────────────────────────────
function updateWishlistBadge() {
  // Re-render visible wish-btn hearts
  const list = window.getWishlist ? getWishlist() : [];
  document.querySelectorAll('.wish-btn').forEach(btn => {
    const url = btn.dataset.url;
    const wished = list.some(b => b.url === url);
    btn.classList.toggle('wishlisted', wished);
    btn.textContent = wished ? '♥' : '♡';
  });
}

function openWishlistModal() {
  const list = window.getWishlist ? getWishlist() : [];
  const old = document.getElementById('wishlistModal');
  if (old) old.remove();
  const modal = document.createElement('div');
  modal.id = 'wishlistModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(13,11,8,0.94);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;z-index:9000;';
  const items = list.length ? list.map(b => `
    <div style="display:flex;gap:1rem;align-items:center;padding:0.8rem 0;border-bottom:1px solid rgba(201,168,76,0.1);">
      ${b.img ? `<img src="${b.img}" style="width:44px;height:64px;object-fit:cover;" alt=""/>` : ''}
      <div style="flex:1;min-width:0;">
        <div style="font-size:0.82rem;color:#f0e8d8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${b.title||''}</div>
        <div style="font-size:0.7rem;color:#c9a84c;margin-top:0.2rem;">${b.price ? '₹' + Number(b.price).toLocaleString('en-IN') : ''}</div>
      </div>
      <div style="display:flex;gap:0.5rem;">
        <button onclick="addToCart({id:'${b.url}',title:'${(b.title||'').replace(/'/g,"\\'")}',price:${Number(b.price)||0},img:'${b.img||''}',url:'${b.url}'}); document.getElementById('wishlistModal').remove(); openCart();"
          style="font-size:0.58rem;letter-spacing:0.18em;text-transform:uppercase;padding:0.5rem 0.9rem;background:#c9a84c;color:#0d0b08;border:none;cursor:pointer;font-family:'Montserrat',sans-serif;">
          Add to Cart
        </button>
        <button onclick="toggleWishlist({url:'${b.url}'});openWishlistModal();"
          style="font-size:0.9rem;background:none;border:none;color:#e05050;cursor:pointer;">✕</button>
      </div>
    </div>`).join('') : `<p style="color:#a09080;font-size:0.82rem;text-align:center;padding:2rem;">Your wishlist is empty.<br/><a href="#featured" onclick="document.getElementById('wishlistModal').remove()" style="color:#c9a84c;">Browse books →</a></p>`;
  modal.innerHTML = `
    <div style="background:#1c1916;border:1px solid rgba(201,168,76,0.22);width:min(500px,92vw);padding:2.4rem;position:relative;max-height:80vh;overflow-y:auto;">
      <button onclick="document.getElementById('wishlistModal').remove()"
        style="position:absolute;top:1rem;right:1.2rem;background:none;border:none;color:#a09080;font-size:1.3rem;cursor:pointer;">✕</button>
      <div style="font-size:0.58rem;letter-spacing:0.35em;text-transform:uppercase;color:#c9a84c;margin-bottom:0.5rem;">Saved Books</div>
      <h3 style="font-family:'Cormorant Garamond',serif;font-size:1.7rem;font-weight:300;color:#faf7f2;margin-bottom:1.5rem;">My Wishlist (${list.length})</h3>
      ${items}
    </div>`;
  document.body.appendChild(modal);
}

// ── NEWSLETTER ──────────────────────────────────────────────────────────────
function subscribeNewsletter(e) {
  e.preventDefault();
  const email = document.getElementById('nlEmail')?.value.trim();
  const msg   = document.getElementById('nlMsg');
  if (!email || !email.includes('@')) { msg.textContent = 'Please enter a valid email.'; msg.style.color = '#e06060'; return; }
  // Store in Supabase if available
  const sb = window.supabase && window.SUPABASE_URL !== 'SUPABASE_URL_PLACEHOLDER'
    ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY) : null;
  if (sb) sb.from('newsletter').insert({ email }).then(() => {});
  msg.style.color = '#6dbf6d';
  msg.textContent = '✓ You\'re subscribed! Expect our first newsletter soon.';
  document.getElementById('nlEmail').value = '';
}

// ── SUMMER SALE COUNTDOWN ─────────────────────────────────────────────────
const SALE_END_DATE = new Date('2026-05-19T18:30:00Z'); // midnight IST May 19

function formatCountdown(diff) {
  if (diff <= 0) return null;
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return { d, h: String(h).padStart(2,'0'), m: String(m).padStart(2,'0'), s: String(s).padStart(2,'0') };
}

function updateSaleCountdown() {
  const diff = SALE_END_DATE.getTime() - Date.now();
  const t = formatCountdown(diff);

  // Big banner countdown
  const big = document.getElementById('saleCountdown');
  if (big) {
    if (!t) { document.getElementById('summerSale')?.remove(); return; }
    big.innerHTML =
      `<div class="cd-block"><span class="cd-num">${t.d}</span><span class="cd-label">Days</span></div>` +
      `<span class="cd-sep">:</span>` +
      `<div class="cd-block"><span class="cd-num">${t.h}</span><span class="cd-label">Hours</span></div>` +
      `<span class="cd-sep">:</span>` +
      `<div class="cd-block"><span class="cd-num">${t.m}</span><span class="cd-label">Mins</span></div>` +
      `<span class="cd-sep">:</span>` +
      `<div class="cd-block"><span class="cd-num">${t.s}</span><span class="cd-label">Secs</span></div>`;
  }

  // Promo bar mini timer
  const mini = document.getElementById('promoTimer');
  if (mini && t) mini.textContent = `${t.d}d ${t.h}h ${t.m}m ${t.s}s`;
  else if (mini && !t) mini.textContent = '';
}

if (Date.now() < SALE_END_DATE.getTime()) {
  updateSaleCountdown();
  setInterval(updateSaleCountdown, 1000);
} else {
  document.getElementById('summerSale')?.remove();
}

// ── INIT ──────────────────────────────────────────────────────────────────
const totalStat = document.getElementById('stat-total');
if (totalStat) totalStat.textContent = BOOKS.length.toLocaleString() + '+';
document.getElementById('view-all-link').textContent = `View self-help books`;
loadProductOverrides().finally(renderBooks);
renderCollections();
renderShelves();
renderCats(ALL_CATS);

// ── Scroll-reveal: collection cards ──────────────────────────────────────
const obs = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      e.target.style.opacity = '1';
      e.target.style.transform = 'translateY(0)';
      obs.unobserve(e.target);
    }
  });
}, { threshold: 0.08 });
document.querySelectorAll('.coll-card').forEach((el, i) => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(25px)';
  el.style.transition = `opacity 0.65s cubic-bezier(0.22,1,0.36,1) ${(i%4)*0.08}s, transform 0.65s cubic-bezier(0.22,1,0.36,1) ${(i%4)*0.08}s`;
  obs.observe(el);
});

// ── Scroll-reveal: section headings & banners ─────────────────────────────
const srObs = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('in'); srObs.unobserve(e.target); }
  });
}, { threshold: 0.08, rootMargin: '0px 0px -30px 0px' });
document.querySelectorAll('.section-label, .section-title, .summer-sale-banner, .marquee-bar, .editorial-section').forEach(el => {
  el.classList.add('sr');
  srObs.observe(el);
});

// ── Book card staggered reveal ────────────────────────────────────────────
const bookObs = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('in'); bookObs.unobserve(e.target); }
  });
}, { threshold: 0.04 });
document.querySelectorAll('.book-card').forEach((el, i) => {
  el.classList.add('sr');
  el.style.transitionDelay = `${(i % 5) * 0.07}s`;
  bookObs.observe(el);
});

// ── Stat counter animation ────────────────────────────────────────────────
document.querySelectorAll('.stat-num').forEach(el => {
  const raw = el.textContent.trim();
  const num = parseFloat(raw.replace(/[^\d.]/g, ''));
  if (isNaN(num) || num === 0) return;
  const suffix = raw.match(/[^\d.]+$/)?.[0] || '';
  const prefix = raw.match(/^[^0-9]*/)?.[0] || '';
  el.setAttribute('data-target', num);
  el.setAttribute('data-suffix', suffix);
  el.setAttribute('data-prefix', prefix);
  el.textContent = prefix + '0' + suffix;
  const statObs = new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting) return;
    const start = performance.now();
    const dur = 1400;
    (function tick(now) {
      const p = Math.min((now - start) / dur, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      const val = Math.round(num * ease);
      el.textContent = prefix + val + suffix;
      if (p < 1) requestAnimationFrame(tick);
    })(start);
    statObs.unobserve(el);
  }, { threshold: 0.6 });
  statObs.observe(el);
});
</script>
</body>
</html>
"""

# ── Inject real data ─────────────────────────────────────────────────────────
import os
HTML = HTML.replace("BOOKS_DATA_PLACEHOLDER",         books_js)
HTML = HTML.replace("COLLECTIONS_DATA_PLACEHOLDER",   json.dumps(coll_data, ensure_ascii=False))
HTML = HTML.replace("ALL_CATS_DATA_PLACEHOLDER",      all_cats_js)
HTML = HTML.replace("NAV_CATEGORIES_PLACEHOLDER",     nav_categories_html)
HTML = HTML.replace("RICH_DAD_HINDI_IMAGE_PLACEHOLDER", public_image_url("https://cdn.shopify.com/s/files/1/0777/8100/8701/files/18a3b96e-fe0b-4de2-99ba-d6900b02f8b0.jpg?v=1697648603"))
HTML = HTML.replace("ATOMIC_HABITS_HINDI_IMAGE_PLACEHOLDER", public_image_url("https://cdn.shopify.com/s/files/1/0777/8100/8701/files/51nmc82kxql-1c1458a1-51a7-4d5d-b100-4255d57076aa.jpg?v=1697649002"))
HTML = HTML.replace("LAWS_48_HINDI_IMAGE_PLACEHOLDER", public_image_url("https://cdn.shopify.com/s/files/1/0777/8100/8701/files/51-RRmYWh9L._SL1000.jpg?v=1700040895"))
HTML = HTML.replace("RAZORPAY_PUB_KEY_PLACEHOLDER",   os.environ.get("RAZORPAY_KEY_ID", "rzp_test_CHANGE_ME"))
HTML = HTML.replace("SUPABASE_URL_PLACEHOLDER",       os.environ.get("SUPABASE_URL", ""))
HTML = HTML.replace("SUPABASE_ANON_KEY_PLACEHOLDER",  os.environ.get("SUPABASE_ANON_KEY", ""))
HTML = with_reader_activity(HTML)
HTML = with_meta_pixel(HTML)

out = Path(__file__).parent / "public" / "index.html"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(HTML, encoding="utf-8")
size_kb = len(HTML.encode()) / 1024
print(f"Generated: {out}  ({size_kb:.0f} KB)")

# ── Generate product.html ────────────────────────────────────────────────────
razorpay_key = os.environ.get("RAZORPAY_KEY_ID", "rzp_test_CHANGE_ME")

PRODUCT_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"/>
<meta http-equiv="Pragma" content="no-cache"/>
<meta http-equiv="Expires" content="0"/>
<title>Loading… — Ink &amp; Chai</title>
<meta name="description" content="Buy books online at Ink &amp; Chai — fast pan-India delivery."/>
<meta name="robots" content="index,follow"/>
<meta name="keywords" content="buy books online india, hindi books, self help books hindi, fiction books online, motivational books, ink and chai"/>
<meta property="og:type" content="product"/>
<meta property="og:site_name" content="Ink &amp; Chai"/>
<meta property="og:title" id="ogTitle" content="Ink &amp; Chai — Books"/>
<meta property="og:description" id="ogDesc" content="Buy books online at Ink &amp; Chai."/>
<meta property="og:image" id="ogImg" content="https://inkandchai.in/images/og-default.jpg"/>
<meta property="og:url" id="ogUrl" content="https://inkandchai.in/"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" id="twTitle" content="Ink &amp; Chai — Books"/>
<meta name="twitter:description" id="twDesc" content="Buy books online at Ink &amp; Chai."/>
<meta name="twitter:image" id="twImg" content="https://inkandchai.in/images/og-default.jpg"/>
<link rel="canonical" id="canonLink" href="https://inkandchai.in/product/"/>
<link rel="icon" type="image/png" sizes="32x32" href="/images/favicon-32.png"/>
<link rel="icon" type="image/png" sizes="96x96" href="/images/favicon-96.png"/>
<link rel="icon" type="image/png" sizes="192x192" href="/images/icon-192.png"/>
<link rel="apple-touch-icon" href="/images/apple-touch-icon.png"/>
<link rel="manifest" href="/manifest.json"/>
<script type="application/ld+json" id="ldjson">{}</script>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400;1,600&family=Montserrat:wght@300;400;500;600&display=swap" rel="stylesheet"/>
<script>
  (function(){ try { var t = localStorage.getItem('iac_theme'); if (t === 'light') document.documentElement.setAttribute('data-theme','light'); } catch(e){ /* dark default */ } })();
  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme');
    var next = cur === 'light' ? 'dark' : 'light';
    if (next) document.documentElement.setAttribute('data-theme', next);
    else      document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('iac_theme', next); } catch(e){}
  }
</script>
<style>
:root{--bg:#0d0b08;--bg2:#141210;--bg3:#1c1916;--gold:#c9a84c;--gold-light:#e8c97a;--gold-dim:#7a6330;--cream:#f0e8d8;--cream-dim:#a09080;--white:#faf7f2;--border:rgba(201,168,76,0.18)}
html[data-theme="light"]{--bg:#faf7f2;--bg2:#f3ece0;--bg3:#ffffff;--gold:#8a6a1f;--gold-light:#b8902c;--gold-dim:#6a4f10;--cream:#2a2018;--cream-dim:#5a4a38;--white:#0d0b08;--border:rgba(138,106,31,0.28)}
html[data-theme="light"] nav{background:rgba(250,247,242,0.97)!important}
html[data-theme="light"] .prod-cover{background:#f0e8d4}
html[data-theme="light"] .prod-cover img{box-shadow:0 12px 32px rgba(60,40,10,0.2)}
html[data-theme="light"] .promo-banner{background:linear-gradient(90deg,#fff8e6,#fbeec8,#fff8e6);color:#5a4a18}
html[data-theme="light"] .promo-banner code{background:rgba(138,106,31,0.12);color:#6a4f10;border-color:rgba(138,106,31,0.4)}
html[data-theme="light"] .prod-bottom-bar{background:rgba(250,247,242,0.97)}
html[data-theme="light"] .promise-box{background:rgba(138,106,31,0.06)}
html[data-theme="light"] .prod-title{color:#1a1208}
html[data-theme="light"] .prod-price{color:#6a4f10}
.theme-toggle{background:transparent;border:1px solid var(--gold-dim);color:var(--gold);width:34px;height:34px;border-radius:50%;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:0.85rem;transition:all 0.3s;margin-right:0.4rem}
.theme-toggle:hover{background:var(--gold);color:var(--bg);transform:rotate(20deg)}
.theme-toggle .sun{display:none}
html[data-theme="light"] .theme-toggle .moon{display:none}
html[data-theme="light"] .theme-toggle .sun{display:inline}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--cream);font-family:'Montserrat',sans-serif;font-weight:400;min-height:100vh}

/* NAV */
nav{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:1.2rem 4rem;background:rgba(13,11,8,0.97);border-bottom:1px solid var(--border);backdrop-filter:blur(12px)}
.nav-logo{display:inline-flex;align-items:center;gap:0.5rem;font-family:'Cormorant Garamond',serif;font-size:1.5rem;font-weight:600;letter-spacing:0.08em;color:var(--gold);text-decoration:none}
.nav-logo .logo-img{height:38px;width:auto;display:block}
.nav-logo .logo-light{display:none}
html[data-theme="light"] .nav-logo .logo-dark{display:none}
html[data-theme="light"] .nav-logo .logo-light{display:block}
@media(max-width:780px){.nav-logo .logo-img{height:32px}}
.nav-back{font-size:0.62rem;letter-spacing:0.2em;text-transform:uppercase;color:var(--cream-dim);text-decoration:none;display:flex;align-items:center;gap:0.5rem;transition:color 0.3s}
.nav-back:hover{color:var(--gold)}
.nav-cart-wrap{position:relative}
.btn-nav{font-family:'Montserrat',sans-serif;font-size:0.62rem;letter-spacing:0.22em;text-transform:uppercase;padding:0.55rem 1.4rem;border:1px solid var(--gold-dim);color:var(--gold);background:transparent;cursor:pointer;transition:all 0.3s;text-decoration:none}
.btn-nav:hover{background:var(--gold);color:var(--bg)}
.cart-badge{background:var(--gold);color:var(--bg);border-radius:50%;width:18px;height:18px;font-size:0.55rem;font-weight:500;display:inline-flex;align-items:center;justify-content:center;position:absolute;top:-6px;right:-8px}

/* PRODUCT LAYOUT */
.product-page{max-width:1200px;margin:0 auto;padding:4rem 2rem 6rem;display:grid;grid-template-columns:minmax(340px,0.9fr) 1.1fr;gap:4rem;align-items:start}
@media(max-width:780px){
  html,body{overflow-x:hidden}
  .product-page{grid-template-columns:1fr;gap:1.2rem;padding:0 1rem 150px;display:block}
  .prod-cover-wrap{position:sticky;top:55px;z-index:50;background:var(--bg);padding:0.6rem 0;margin:0 -1rem 0.8rem;padding-left:1rem;padding-right:1rem;border-bottom:1px solid var(--border)}
  .prod-cover{min-height:auto;padding:0.6rem;background:transparent;border:none}
  .prod-cover img{max-height:160px;box-shadow:0 6px 20px rgba(0,0,0,0.6)}
  .prod-cover-secondary{display:none}
  .prod-badges{margin-top:0.5rem}
  .prod-actions{display:none}
  .prod-bottom-bar{display:flex!important}
  .prod-info{gap:1rem}
  .prod-title{font-size:1.5rem!important}
  .prod-price{font-size:2rem!important}
}

/* LEFT — cover */
.prod-cover-wrap{position:sticky;top:6rem}
.prod-cover{background:var(--bg2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;padding:2rem;min-height:0}
.prod-cover img{max-height:480px;max-width:100%;object-fit:contain;box-shadow:0 24px 64px rgba(0,0,0,0.6);display:block;cursor:zoom-in;transition:transform 0.25s}
.prod-cover img:hover{transform:scale(1.02)}
.prod-cover-secondary img{cursor:zoom-in}

/* Sample PDF "Read inside" button — sits below cover */
.sample-pdf-row{margin-top:1rem;display:flex;justify-content:center}
.btn-sample-pdf{display:inline-flex;align-items:center;gap:0.6rem;font-family:'Montserrat',sans-serif;font-size:0.62rem;letter-spacing:0.18em;text-transform:uppercase;padding:0.7rem 1.2rem;background:rgba(201,168,76,0.08);color:var(--gold);border:1px dashed rgba(201,168,76,0.45);cursor:pointer;font-weight:500;transition:all 0.2s;text-decoration:none}
.btn-sample-pdf:hover{background:var(--gold);color:var(--bg);border-style:solid}
.btn-sample-pdf .ic{font-size:0.95rem}

/* Lightbox / image-zoom modal */
.lightbox{position:fixed;inset:0;background:rgba(0,0,0,0.94);z-index:10500;display:none;align-items:center;justify-content:center;padding:2rem;cursor:zoom-out;backdrop-filter:blur(8px)}
.lightbox.show{display:flex;animation:lbFade 0.25s ease}
@keyframes lbFade{from{opacity:0}to{opacity:1}}
.lightbox img{max-width:96vw;max-height:92vh;object-fit:contain;box-shadow:0 30px 80px rgba(0,0,0,0.6);background:#1a1208;cursor:zoom-out}
.lightbox-close{position:absolute;top:1.4rem;right:1.4rem;width:42px;height:42px;border-radius:50%;background:rgba(13,11,8,0.85);color:var(--gold);border:1px solid rgba(201,168,76,0.4);cursor:pointer;font-size:1.4rem;display:flex;align-items:center;justify-content:center;transition:all 0.2s}
.lightbox-close:hover{background:var(--gold);color:var(--bg)}
@media(max-width:780px){.lightbox{padding:0.5rem}.lightbox-close{top:0.6rem;right:0.6rem;width:36px;height:36px}}

/* PDF preview modal */
.pdf-modal{position:fixed;inset:0;background:rgba(0,0,0,0.94);z-index:10600;display:none;align-items:center;justify-content:center;padding:1.5rem;backdrop-filter:blur(8px)}
.pdf-modal.show{display:flex;animation:lbFade 0.25s ease}
.pdf-modal-frame{position:relative;width:100%;max-width:980px;height:92vh;background:var(--bg2);border:1px solid var(--border);display:flex;flex-direction:column}
.pdf-modal-head{display:flex;align-items:center;justify-content:space-between;padding:0.9rem 1.2rem;border-bottom:1px solid var(--border);background:var(--bg3);gap:0.8rem}
.pdf-modal-title{font-family:'Cormorant Garamond',serif;font-size:1.05rem;color:var(--cream);font-weight:500;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pdf-modal-actions{display:flex;gap:0.5rem;align-items:center}
.pdf-modal-actions a,.pdf-modal-actions button{font-family:'Montserrat',sans-serif;font-size:0.55rem;letter-spacing:0.18em;text-transform:uppercase;padding:0.5rem 0.9rem;background:transparent;color:var(--cream-dim);border:1px solid var(--border);cursor:pointer;text-decoration:none;transition:all 0.2s}
.pdf-modal-actions a:hover,.pdf-modal-actions button:hover{border-color:var(--gold);color:var(--gold)}
.pdf-modal-actions .pdf-close{background:rgba(201,168,76,0.1);color:var(--gold);border-color:var(--gold-dim)}
.pdf-modal iframe{flex:1;width:100%;border:none;background:#1a1410}
@media(max-width:780px){.pdf-modal{padding:0}.pdf-modal-frame{height:100vh}.pdf-modal-title{font-size:0.85rem}}
.prod-cover-secondary{margin-top:1rem;background:var(--bg2);border:1px solid var(--border);padding:1rem;display:flex;align-items:center;justify-content:center}
.prod-cover-secondary img{max-height:340px;max-width:100%;object-fit:contain;box-shadow:0 14px 36px rgba(0,0,0,0.45);display:block}
.prod-cover-placeholder{width:200px;height:300px;background:linear-gradient(135deg,#1a0a00,#3a1500)}
.prod-badges{display:flex;gap:0.6rem;flex-wrap:wrap;margin-top:1.2rem}
.badge{font-size:0.55rem;letter-spacing:0.2em;text-transform:uppercase;padding:0.35rem 0.8rem;border:1px solid var(--border);color:var(--cream-dim)}
.badge.sale{border-color:rgba(109,191,109,0.4);color:#6dbf6d;background:rgba(109,191,109,0.07)}

/* RIGHT — info */
.prod-info{display:flex;flex-direction:column;gap:1.4rem}
.prod-breadcrumb{font-size:0.58rem;letter-spacing:0.25em;text-transform:uppercase;color:var(--gold)}
.prod-breadcrumb a{color:var(--gold-dim);text-decoration:none;transition:color 0.2s}
.prod-breadcrumb a:hover{color:var(--gold)}
.prod-title{font-family:'Cormorant Garamond',serif;font-size:clamp(1.8rem,4vw,2.8rem);font-weight:400;color:var(--white);line-height:1.15}
.prod-author{font-size:0.8rem;color:var(--cream-dim);letter-spacing:0.1em}
.prod-author span{color:var(--cream)}
.divider{height:1px;background:var(--border)}
.prod-price-row{display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
.prod-price{font-family:'Cormorant Garamond',serif;font-size:2.4rem;color:var(--gold);font-weight:600;line-height:1}
.prod-orig{font-size:1rem;color:var(--cream-dim);text-decoration:line-through}
.prod-saving{font-size:0.65rem;letter-spacing:0.12em;text-transform:uppercase;color:#6dbf6d;background:rgba(109,191,109,0.1);padding:0.3rem 0.7rem;border:1px solid rgba(109,191,109,0.25)}
.prod-trust-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.55rem;margin-top:-0.2rem}
.prod-trust-row span{border:1px solid rgba(201,168,76,0.18);background:rgba(201,168,76,0.05);color:var(--cream);font-size:0.68rem;line-height:1.4;padding:0.55rem 0.7rem}
.prod-desc-title{font-size:0.6rem;letter-spacing:0.3em;text-transform:uppercase;color:var(--gold);margin-bottom:0.6rem}
.prod-desc{font-size:0.82rem;color:var(--cream-dim);line-height:1.9;letter-spacing:0.03em}
.prod-meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:0.8rem 2rem}
.prod-meta-item{}
.prod-meta-label{font-size:0.55rem;letter-spacing:0.25em;text-transform:uppercase;color:var(--gold-dim);margin-bottom:0.2rem}
.prod-meta-val{font-size:0.78rem;color:var(--cream)}

/* ACTIONS */
.prod-actions{display:flex;flex-direction:column;gap:0.8rem;margin-top:0.5rem}
.btn-cart{width:100%;font-family:'Montserrat',sans-serif;font-size:0.65rem;letter-spacing:0.25em;text-transform:uppercase;padding:1.1rem;background:var(--gold);color:var(--bg);border:none;cursor:pointer;font-weight:500;transition:all 0.3s}
.btn-cart:hover{background:var(--gold-light);transform:translateY(-1px);box-shadow:0 8px 24px rgba(201,168,76,0.25)}
.btn-cod{width:100%;font-family:'Montserrat',sans-serif;font-size:0.65rem;letter-spacing:0.25em;text-transform:uppercase;padding:1.1rem;background:rgba(201,168,76,0.12);color:var(--gold);border:1px solid var(--gold-dim);cursor:pointer;font-weight:500;transition:all 0.3s}
.btn-cod:hover{background:var(--gold);color:var(--bg);transform:translateY(-1px);box-shadow:0 8px 24px rgba(201,168,76,0.2)}
.btn-cart.is-loading,.btn-cod.is-loading,.pbb-cart.is-loading,.pbb-buy.is-loading{position:relative;pointer-events:none;opacity:0.78;color:transparent!important}
.btn-cart.is-loading::after,.btn-cod.is-loading::after,.pbb-cart.is-loading::after,.pbb-buy.is-loading::after{content:'';position:absolute;left:50%;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spinBtn .75s linear infinite;color:var(--bg)}
.btn-cod.is-loading::after,.pbb-cart.is-loading::after{color:var(--gold)}
@keyframes spinBtn{to{transform:rotate(360deg)}}
.btn-share{font-size:0.6rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--cream-dim);background:none;border:none;cursor:pointer;display:flex;align-items:center;gap:0.4rem;transition:color 0.2s;font-family:'Montserrat',sans-serif}
.btn-share:hover{color:var(--gold)}

/* MOBILE BOTTOM BAR */
.prod-bottom-bar{display:none;position:fixed;bottom:0;left:0;right:0;z-index:9999;background:rgba(13,11,8,0.98);border-top:1px solid rgba(201,168,76,0.3);padding:0.75rem 1rem calc(0.75rem + env(safe-area-inset-bottom,0px));gap:0.6rem;align-items:center;backdrop-filter:blur(16px);box-shadow:0 -8px 24px rgba(0,0,0,0.5)}
.pbb-cart{flex:1;font-family:'Montserrat',sans-serif;font-size:0.6rem;letter-spacing:0.18em;text-transform:uppercase;padding:0.9rem 0.5rem;background:rgba(201,168,76,0.12);color:var(--gold);border:1px solid rgba(201,168,76,0.4);cursor:pointer;font-weight:500;transition:all 0.2s}
.pbb-buy{flex:1.5;font-family:'Montserrat',sans-serif;font-size:0.63rem;letter-spacing:0.18em;text-transform:uppercase;padding:0.9rem 0.5rem;background:var(--gold);color:var(--bg);border:none;cursor:pointer;font-weight:700;transition:all 0.2s}
.pbb-cart:active{background:var(--gold);color:var(--bg)}
.pbb-buy:active{background:var(--gold-light)}

/* QUANTITY SELECTOR */
.qty-row{display:flex;align-items:center;gap:1rem;margin-top:0.2rem}
.qty-label{font-size:0.57rem;letter-spacing:0.22em;text-transform:uppercase;color:var(--gold-dim)}
.qty-ctrl{display:flex;align-items:center}
.qty-ctrl button{width:36px;height:36px;background:var(--bg2);border:1px solid var(--border);color:var(--cream);font-size:1.15rem;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:border-color 0.2s,color 0.2s}
.qty-ctrl button:hover{border-color:var(--gold);color:var(--gold)}
.qty-num{width:46px;height:36px;display:flex;align-items:center;justify-content:center;border-top:1px solid var(--border);border-bottom:1px solid var(--border);font-size:0.95rem;color:var(--cream);font-family:'Montserrat',sans-serif;user-select:none}

/* STAR RATING */
.prod-rating{display:flex;align-items:center;gap:0.6rem;margin-bottom:0.2rem}
.prod-stars{color:#c9a84c;font-size:1.05rem;letter-spacing:0.04em}
.prod-rating-label{font-size:0.7rem;color:var(--cream-dim)}
.prod-order-badge{display:inline-flex;align-items:center;gap:0.4rem;width:max-content;margin-top:-0.25rem;border:1px solid rgba(201,168,76,0.35);background:rgba(201,168,76,0.1);color:var(--gold-light);font-size:0.62rem;letter-spacing:0.18em;text-transform:uppercase;padding:0.42rem 0.75rem}
.review-panel{border:1px solid rgba(201,168,76,0.24);background:rgba(201,168,76,0.045);padding:1.15rem;margin-top:0.35rem}
.review-head{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;margin-bottom:0.95rem}
.review-kicker{font-size:0.56rem;letter-spacing:0.28em;text-transform:uppercase;color:var(--gold);margin-bottom:0.25rem}
.review-title{font-family:'Cormorant Garamond',serif;font-size:1.35rem;color:var(--white);line-height:1.1}
.review-score{text-align:right;flex-shrink:0}
.review-score strong{font-family:'Cormorant Garamond',serif;font-size:2rem;color:var(--gold);line-height:1}
.review-score span{display:block;font-size:0.6rem;color:var(--cream-dim);letter-spacing:0.12em;text-transform:uppercase;margin-top:0.2rem}
.review-media{display:grid;grid-template-columns:1fr 1fr;gap:0.8rem}
.review-media figure{margin:0;border:1px solid rgba(201,168,76,0.22);background:rgba(0,0,0,0.18);overflow:hidden}
.review-media img,.review-media video{width:100%;height:220px;object-fit:cover;display:block;background:#090704}
.review-media figcaption{padding:0.65rem 0.75rem;font-size:0.62rem;color:var(--cream-dim);letter-spacing:0.09em;line-height:1.5}
.review-note{font-size:0.74rem;color:var(--cream-dim);line-height:1.7;margin-top:0.9rem}
@media(max-width:720px){.review-head{display:block}.review-score{text-align:left;margin-top:0.7rem}.review-media{grid-template-columns:1fr}.review-media img,.review-media video{height:auto;max-height:360px;object-fit:contain}}

/* INK & CHAI PROMISE */
.promise-box{border:1px solid rgba(201,168,76,0.2);background:rgba(201,168,76,0.04);padding:1rem 1.2rem;border-radius:2px}
.promise-box-title{font-size:0.56rem;letter-spacing:0.28em;text-transform:uppercase;color:var(--gold);margin-bottom:0.5rem;display:flex;align-items:center;gap:0.4rem}
.promise-box-text{font-size:0.76rem;color:var(--cream-dim);line-height:1.75}
.promise-box-text strong{color:var(--cream)}

/* FREQUENTLY BOUGHT TOGETHER */
.fbt{max-width:1100px;margin:2.5rem auto 0;padding:0 2rem}
.fbt-title{font-family:'Cormorant Garamond',serif;font-size:1.5rem;font-weight:400;color:var(--white);margin-bottom:1.4rem}
.fbt-title em{font-style:italic;color:var(--gold-light)}
.fbt-box{background:var(--bg2);border:1px solid var(--border);padding:1.6rem}
html[data-theme="light"] .fbt-box{background:var(--bg3)}
.fbt-row{display:flex;align-items:center;gap:1rem;padding:0.8rem 0;border-bottom:1px solid var(--border)}
.fbt-row:last-child{border-bottom:none}
.fbt-check{flex-shrink:0;width:22px;height:22px;cursor:pointer;accent-color:var(--gold)}
.fbt-thumb{width:54px;aspect-ratio:2/3;flex-shrink:0;background:var(--bg);border:1px solid var(--border);overflow:hidden;cursor:pointer}
.fbt-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.fbt-info{flex:1;min-width:0;cursor:pointer}
.fbt-name{font-family:'Cormorant Garamond',serif;font-size:0.95rem;color:var(--cream);line-height:1.3;margin-bottom:0.2rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.fbt-author{font-size:0.65rem;color:var(--cream-dim);letter-spacing:0.05em}
.fbt-pricecol{font-family:'Cormorant Garamond',serif;text-align:right;flex-shrink:0}
.fbt-price{font-size:1rem;color:var(--gold);font-weight:600}
.fbt-orig{display:block;font-size:0.7rem;color:var(--cream-dim);text-decoration:line-through;font-weight:400}
.fbt-current{background:rgba(201,168,76,0.08);padding:0.2rem 0.5rem;font-size:0.55rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--gold);margin-left:0.6rem;border:1px solid rgba(201,168,76,0.3)}
.fbt-summary{display:flex;justify-content:space-between;align-items:center;margin-top:1.2rem;padding-top:1rem;border-top:1px dashed var(--border);flex-wrap:wrap;gap:1rem}
.fbt-total{font-family:'Cormorant Garamond',serif}
.fbt-total-label{font-size:0.6rem;letter-spacing:0.22em;text-transform:uppercase;color:var(--cream-dim);margin-bottom:0.2rem;display:block}
.fbt-total-amt{font-size:1.6rem;color:var(--gold);font-weight:600}
.fbt-total-orig{font-size:0.85rem;color:var(--cream-dim);text-decoration:line-through;margin-left:0.6rem;font-weight:400}
.fbt-cta{font-family:'Montserrat',sans-serif;font-size:0.62rem;letter-spacing:0.22em;text-transform:uppercase;padding:0.95rem 1.6rem;background:var(--gold);color:var(--bg);border:none;cursor:pointer;font-weight:600;transition:all 0.25s}
.fbt-cta:hover{background:var(--gold-light);transform:translateY(-1px);box-shadow:0 8px 24px rgba(201,168,76,0.25)}
@media(max-width:780px){
  .fbt{padding:0 1rem}
  .fbt-thumb{width:42px}
  .fbt-name{font-size:0.82rem}
  .fbt-price{font-size:0.9rem}
  .fbt-total-amt{font-size:1.3rem}
  .fbt-cta{width:100%}
}

/* #InkAndChaiBookstagram — horizontal social-proof strip */
.bkg-section{max-width:1100px;margin:3rem auto 0;padding:0 2rem}
.bkg-title{font-family:'Cormorant Garamond',serif;font-size:1.5rem;font-weight:400;color:var(--white);margin-bottom:0.4rem}
.bkg-title em{font-style:italic;color:var(--gold-light)}
.bkg-sub{font-size:0.65rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--gold-dim);margin-bottom:1.2rem}
.bkg-strip{display:flex;gap:1rem;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:1rem;margin:0 -2rem;padding-left:2rem;padding-right:2rem;scrollbar-width:thin;scrollbar-color:var(--gold-dim) var(--bg2)}
.bkg-strip::-webkit-scrollbar{height:6px}
.bkg-strip::-webkit-scrollbar-track{background:var(--bg2)}
.bkg-strip::-webkit-scrollbar-thumb{background:var(--gold-dim);border-radius:3px}
.bkg-card{flex:0 0 200px;aspect-ratio:9/16;background:var(--bg2);border:1px solid var(--border);position:relative;overflow:hidden;scroll-snap-align:start;cursor:pointer;transition:transform 0.25s,border-color 0.25s}
.bkg-card:hover{transform:translateY(-4px);border-color:rgba(201,168,76,0.5)}
.bkg-card img,.bkg-card video{width:100%;height:100%;object-fit:cover;display:block}
.bkg-card .bkg-overlay{position:absolute;inset:auto 0 0 0;padding:0.7rem;background:linear-gradient(to top,rgba(0,0,0,0.85),transparent);font-size:0.7rem;color:#f0e8d8;line-height:1.3}
.bkg-card .bkg-play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:46px;height:46px;border-radius:50%;background:rgba(13,11,8,0.7);display:flex;align-items:center;justify-content:center;color:var(--gold);font-size:1.2rem;backdrop-filter:blur(8px);pointer-events:none}
.bkg-card video{display:block}
.bkg-card.is-playing .bkg-play{display:none}
.bkg-ig-chip{position:absolute;top:8px;right:8px;background:rgba(13,11,8,0.7);color:var(--gold);font-size:0.5rem;letter-spacing:0.18em;text-transform:uppercase;padding:0.3rem 0.5rem;text-decoration:none;backdrop-filter:blur(8px)}
.bkg-empty{font-size:0.72rem;color:var(--cream-dim);padding:0.6rem 0 1rem;line-height:1.6}
.bkg-empty code{background:var(--bg2);color:var(--gold);font-family:Menlo,Consolas,monospace;font-size:0.68rem;padding:0.1rem 0.4rem;border:1px solid var(--border)}
@media(max-width:780px){
  .bkg-section{padding:0 1rem;margin-top:2rem}
  .bkg-strip{margin:0 -1rem;padding-left:1rem;padding-right:1rem}
  .bkg-card{flex:0 0 160px}
  .bkg-title{font-size:1.25rem}
}

/* RELATED / YOU MAY ALSO LIKE */
.related{max-width:1260px;margin:0 auto;padding:0 2rem 6rem}
.related-title{font-family:'Cormorant Garamond',serif;font-size:1.8rem;font-weight:400;color:var(--white);margin-bottom:2rem}
.related-title em{font-style:italic;color:var(--gold-light)}
.related-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:1.2rem}
@media(max-width:1100px){.related-grid{grid-template-columns:repeat(4,1fr)}}
@media(max-width:780px){.related-grid{grid-template-columns:repeat(2,1fr);gap:.9rem}}
.rel-card{cursor:pointer;transition:transform 0.2s,border-color 0.2s;border:1px solid transparent;color:inherit}
.rel-card:hover{transform:translateY(-3px)}
.rel-card:hover .rel-cover{border-color:rgba(201,168,76,0.55)}
.rel-cover{aspect-ratio:2/3;background:var(--bg2);border:1px solid var(--border);overflow:hidden;margin-bottom:0.65rem;transition:border-color 0.2s}
.rel-cover img{width:100%;height:100%;object-fit:contain;display:block;background:#1a1208}
.rel-title{font-family:'Cormorant Garamond',serif;font-size:0.88rem;color:var(--cream);line-height:1.3;margin-bottom:0.2rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rel-author{font-size:0.68rem;color:var(--muted);letter-spacing:0.04em;margin-bottom:0.2rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rel-price{font-size:0.82rem;color:var(--gold);font-weight:600}

/* CART SIDEBAR (same as homepage) */
.cart-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9990;opacity:0;pointer-events:none;transition:opacity 0.35s}
.cart-overlay.show{opacity:1;pointer-events:all}
.cart-sidebar{position:fixed;top:0;right:0;bottom:0;width:min(420px,100vw);background:var(--bg3);border-left:1px solid var(--border);z-index:10001;transform:translateX(100%);transition:transform 0.35s cubic-bezier(0.4,0,0.2,1);display:flex;flex-direction:column}
.cart-sidebar.open{transform:translateX(0)}
.cart-header{display:flex;justify-content:space-between;align-items:center;padding:1.6rem 1.8rem;border-bottom:1px solid var(--border)}
.cart-title{font-family:'Cormorant Garamond',serif;font-size:1.4rem;font-weight:400;color:var(--white)}
.cart-close{background:none;border:none;color:var(--cream-dim);font-size:1.3rem;cursor:pointer;padding:0.2rem 0.4rem;transition:color 0.2s}
.cart-close:hover{color:var(--gold)}
.cart-body{flex:1;overflow-y:auto;padding:1.2rem 1.8rem}
.cart-empty{text-align:center;padding:4rem 1rem;color:var(--cream-dim);font-size:0.78rem;letter-spacing:0.08em}
.cart-empty-icon{font-size:2.5rem;margin-bottom:1rem;opacity:0.3}
.cart-item{display:flex;gap:1rem;padding:1.2rem 0;border-bottom:1px solid var(--border)}
.cart-item-img{width:64px;flex-shrink:0;aspect-ratio:2/3;background:var(--bg2);overflow:hidden}
.cart-item-img img{width:100%;height:100%;object-fit:cover}
.cart-item-img-placeholder{width:100%;height:100%;background:linear-gradient(135deg,#1a0a00,#3a1500)}
.cart-item-info{flex:1;min-width:0}
.cart-item-title{font-family:'Cormorant Garamond',serif;font-size:0.95rem;color:var(--cream);line-height:1.3;margin-bottom:0.2rem;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.cart-item-author{font-size:0.6rem;color:var(--cream-dim);letter-spacing:0.08em;margin-bottom:0.4rem}
.cart-item-price{font-family:'Cormorant Garamond',serif;font-size:1rem;color:var(--gold);margin-bottom:0.5rem}
.cart-item-controls{display:flex;align-items:center;gap:0.5rem}
.qty-btn{background:var(--bg2);border:1px solid var(--border);color:var(--cream);width:24px;height:24px;cursor:pointer;font-size:0.9rem;display:flex;align-items:center;justify-content:center;transition:all 0.2s}
.qty-btn:hover{background:var(--gold);color:var(--bg);border-color:var(--gold)}
.qty-num{font-size:0.78rem;color:var(--cream);min-width:20px;text-align:center}
.cart-remove{background:none;border:none;color:var(--cream-dim);font-size:0.6rem;letter-spacing:0.12em;cursor:pointer;text-transform:uppercase;margin-left:0.5rem;transition:color 0.2s}
.cart-remove:hover{color:#e05a5a}
.cart-footer{padding:1.4rem 1.8rem;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:0.8rem}
.cart-total-row{display:flex;justify-content:space-between;align-items:baseline}
.cart-total-label{font-size:0.6rem;letter-spacing:0.22em;text-transform:uppercase;color:var(--cream-dim)}
.cart-total-amount{font-family:'Cormorant Garamond',serif;font-size:1.5rem;color:var(--gold);font-weight:600}
.btn-checkout{width:100%;font-family:'Montserrat',sans-serif;font-size:0.65rem;letter-spacing:0.25em;text-transform:uppercase;padding:1rem;background:var(--gold);color:var(--bg);border:none;cursor:pointer;font-weight:500;transition:all 0.3s}
.btn-checkout:hover{background:var(--gold-light)}

/* NOT FOUND */
.not-found{text-align:center;padding:8rem 2rem;color:var(--cream-dim)}
.not-found h2{font-family:'Cormorant Garamond',serif;font-size:2rem;color:var(--white);margin-bottom:1rem}

/* Promo banner */
.promo-banner{background:linear-gradient(90deg,#1a1410,#2a1f15,#1a1410);border-bottom:1px solid rgba(201,168,76,0.25);padding:0.55rem 1rem;text-align:center;font-size:0.66rem;letter-spacing:0.12em;color:#f0e8d8;font-family:'Montserrat',sans-serif;position:relative;z-index:200}
.promo-banner strong{color:#c9a84c;font-weight:600;letter-spacing:0.18em}
.promo-banner code{background:rgba(201,168,76,0.18);color:#c9a84c;padding:0.15rem 0.55rem;border:1px dashed rgba(201,168,76,0.5);font-family:'Montserrat',sans-serif;font-size:0.62rem;letter-spacing:0.15em;margin-left:0.5rem}
@media(max-width:780px){.promo-banner{display:none}}

/* WhatsApp floating */
.wa-float{position:fixed;bottom:22px;left:22px;width:54px;height:54px;border-radius:50%;background:#25d366;color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(37,211,102,0.45);z-index:250;cursor:pointer;text-decoration:none;transition:transform 0.2s}
.wa-float:hover{transform:scale(1.08)}
@media(max-width:780px){.wa-float{bottom:84px;left:14px;width:48px;height:48px}}
</style>
</head>
<body>

<!-- Promo banner -->
<div class="promo-banner">
  <strong>✦ PREPAID OFFERS</strong> 10% ₹499+ &nbsp;·&nbsp; 12% ₹999+ &nbsp;·&nbsp; 15% ₹1499+
</div>

<!-- WhatsApp -->
<a class="wa-float" href="https://wa.me/919217175546?text=Hi%20Ink%20%26%20Chai%2C%20I%20have%20a%20question%20about%20a%20book." target="_blank" rel="noopener" title="Chat with us on WhatsApp" aria-label="WhatsApp support">
  <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
</a>

<!-- Mobile bottom nav (mobile only) -->
<nav class="mob-nav" aria-label="Mobile navigation">
  <a href="/" title="Home"><span class="mn-icon">⌂</span><span>Home</span></a>
  <button onclick="window.IAC ? IAC.openMyOrders() : null" title="My Orders"><span class="mn-icon">📦</span><span>Orders</span></button>
  <button onclick="openCart()" title="Cart"><span class="mn-icon">🛒</span><span>Cart</span><span class="mn-badge" id="cartBadgeMobile" style="display:none;">0</span></button>
</nav>

<!-- POLICY BAR -->
<div style="background:#1a1612;border-bottom:1px solid rgba(201,168,76,0.12);padding:0.4rem 4rem;display:flex;gap:2rem;justify-content:flex-end;flex-wrap:wrap;">
  <a href="/terms/" style="font-size:0.58rem;letter-spacing:0.18em;text-transform:uppercase;color:#7a6330;text-decoration:none;" onmouseover="this.style.color='#c9a84c'" onmouseout="this.style.color='#7a6330'">Terms &amp; Conditions</a>
  <a href="/privacy-policy/" style="font-size:0.58rem;letter-spacing:0.18em;text-transform:uppercase;color:#7a6330;text-decoration:none;" onmouseover="this.style.color='#c9a84c'" onmouseout="this.style.color='#7a6330'">Privacy Policy</a>
  <a href="/refund-policy/" style="font-size:0.58rem;letter-spacing:0.18em;text-transform:uppercase;color:#7a6330;text-decoration:none;" onmouseover="this.style.color='#c9a84c'" onmouseout="this.style.color='#7a6330'">Refund Policy</a>
  <a href="/return-policy/" style="font-size:0.58rem;letter-spacing:0.18em;text-transform:uppercase;color:#7a6330;text-decoration:none;" onmouseover="this.style.color='#c9a84c'" onmouseout="this.style.color='#7a6330'">Return Policy</a>
  <a href="/shipping-policy/" style="font-size:0.58rem;letter-spacing:0.18em;text-transform:uppercase;color:#7a6330;text-decoration:none;" onmouseover="this.style.color='#c9a84c'" onmouseout="this.style.color='#7a6330'">Shipping Policy</a>
</div>

<!-- NAV -->
<nav>
  <a class="nav-logo" href="/" aria-label="Ink and Chai — home">
    <img class="logo-img logo-dark"  src="/images/logo-light.png" alt="Ink &amp; Chai logo" width="120" height="38"/>
    <img class="logo-img logo-light" src="/images/logo.png"       alt="" width="120" height="38" aria-hidden="true"/>
  </a>
  <a class="nav-back" href="javascript:history.back()">← Back to catalogue</a>
  <div style="display:flex;gap:1rem;align-items:center;">
    <button class="theme-toggle" onclick="toggleTheme()" title="Toggle light/dark mode" aria-label="Toggle theme"><span class="moon">🌙</span><span class="sun">☀️</span></button>
    <button class="btn-nav" onclick="window.IAC ? IAC.openMyOrders() : null" style="margin-right:0.3rem;">📦 My Orders</button>
    <button class="btn-nav auth-nav-btn" id="authNavBtnProd" onclick="window.IAC ? IAC.openAuthModal() : null">👤 Sign In</button>
    <div class="nav-cart-wrap">
      <button class="btn-nav" onclick="openCart()">Cart</button>
      <span class="cart-badge" id="cartBadge" style="display:none;">0</span>
    </div>
  </div>
</nav>

<!-- PRODUCT CONTENT (rendered by JS) -->
<div id="productContent"></div>
<div id="fbtContent"></div>
<div id="bookstagramContent"></div>
<div id="relatedContent"></div>

<!-- Image lightbox (opens when cover is clicked) -->
<div class="lightbox" id="lightbox" onclick="closeLightbox()" role="dialog" aria-label="Book cover preview">
  <button class="lightbox-close" onclick="event.stopPropagation();closeLightbox()" aria-label="Close">✕</button>
  <img id="lightboxImg" src="" alt="" onclick="event.stopPropagation()"/>
</div>

<!-- Sample PDF preview modal — PDF.js canvas render (no iframe = no X-Frame issues) -->
<div class="pdf-modal" id="pdfModal" role="dialog" aria-label="Book sample preview">
  <div class="pdf-modal-frame" onclick="event.stopPropagation()">
    <div class="pdf-modal-head">
      <div class="pdf-modal-title" id="pdfModalTitle">Sample Pages</div>
      <div class="pdf-modal-actions">
        <a id="pdfDownloadLink" href="#" download target="_blank" rel="noopener">⬇ Download</a>
        <button class="pdf-close" onclick="closeSamplePdf()">✕ Close</button>
      </div>
    </div>
    <div id="pdfPagesContainer" style="flex:1;overflow-y:auto;padding:1.2rem;display:flex;flex-direction:column;align-items:center;gap:1rem;background:#1a1410;">
      <div style="color:#a09080;font-size:0.85rem;padding:3rem 1rem;text-align:center;">Loading sample pages...</div>
    </div>
  </div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js" defer></script>

<script>
// Image lightbox
function openLightbox(src, alt) {
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lightboxImg');
  img.src = src;
  img.alt = alt || '';
  lb.classList.add('show');
  document.body.style.overflow = 'hidden';
}
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('show');
  document.body.style.overflow = '';
}

// Sample PDF modal — uses PDF.js to render pages as canvas (no iframe ⇒ no X-Frame-Options blocking)
async function openSamplePdf(pdfUrl, title) {
  const m = document.getElementById('pdfModal');
  const dl = document.getElementById('pdfDownloadLink');
  const pages = document.getElementById('pdfPagesContainer');
  dl.href = pdfUrl;
  document.getElementById('pdfModalTitle').textContent = (title || 'Sample Pages') + ' — Free Sample';
  m.classList.add('show');
  document.body.style.overflow = 'hidden';
  if (window.fbq) fbq('trackCustom', 'ReadSample', { content_name: title || '', content_type: 'product_sample' });

  pages.innerHTML = '<div style="color:#a09080;font-size:0.85rem;padding:3rem 1rem;text-align:center;">Loading sample pages...</div>';

  // Wait for pdf.js to load (deferred script)
  let tries = 0;
  while (typeof pdfjsLib === 'undefined' && tries < 60) {
    await new Promise(r => setTimeout(r, 100));
    tries++;
  }
  if (typeof pdfjsLib === 'undefined') {
    pages.innerHTML = '<div style="color:#e05050;padding:2rem;text-align:center;">Could not load PDF viewer. <a href="' + pdfUrl + '" download style="color:var(--gold);">Download instead</a></div>';
    return;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  try {
    const pdf = await pdfjsLib.getDocument(pdfUrl).promise;
    pages.innerHTML = '';
    const containerWidth = pages.clientWidth - 40;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(2.5, containerWidth / baseViewport.width);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width  = Math.floor(viewport.width  * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width    = Math.floor(viewport.width) + 'px';
      canvas.style.height   = Math.floor(viewport.height) + 'px';
      canvas.style.maxWidth = '100%';
      canvas.style.boxShadow = '0 12px 32px rgba(0,0,0,0.5)';
      canvas.style.background = '#fff';
      ctx.scale(dpr, dpr);
      pages.appendChild(canvas);
      await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    }
    const note = document.createElement('div');
    note.style.cssText = 'color:var(--cream-dim);font-size:0.7rem;letter-spacing:0.18em;text-transform:uppercase;padding:1rem;text-align:center;border-top:1px solid var(--border);margin-top:0.5rem;width:100%;';
    note.innerHTML = 'End of sample · <a href="javascript:closeSamplePdf()" style="color:var(--gold);">Buy the full book →</a>';
    pages.appendChild(note);
  } catch (err) {
    pages.innerHTML = '<div style="color:#e05050;padding:2rem;text-align:center;">Could not render the PDF. <a href="' + pdfUrl + '" download style="color:var(--gold);">Download instead</a></div>';
  }
}
function closeSamplePdf() {
  const m = document.getElementById('pdfModal');
  m.classList.remove('show');
  document.getElementById('pdfPagesContainer').innerHTML = '';
  document.body.style.overflow = '';
}

// ESC closes either modal
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('srchOverlay')?.classList.contains('open')) { closeSiteSearch(); return; }
  if (document.getElementById('lightbox')?.classList.contains('show')) closeLightbox();
  if (document.getElementById('pdfModal')?.classList.contains('show')) closeSamplePdf();
});
</script>

<!-- CART OVERLAY + SIDEBAR -->
<div class="cart-overlay" id="cartOverlay" onclick="closeCart()"></div>
<div class="cart-sidebar" id="cartSidebar">
  <div class="cart-header">
    <span class="cart-title">Your Cart</span>
    <button class="cart-close" onclick="closeCart()">✕</button>
  </div>
  <div class="cart-body">
    <div class="cart-empty" id="cartEmpty">
      <div class="cart-empty-icon">📚</div>
      <div>Your cart is empty.</div>
    </div>
    <div id="cartItems"></div>
  </div>
  <div class="cart-footer" id="cartFooter" style="display:none;">
    <div class="cart-total-row">
      <span class="cart-total-label">Total</span>
      <span class="cart-total-amount" id="cartTotal">₹ 0</span>
    </div>
    <button class="btn-checkout" onclick="window.location.href='/checkout/'">Buy Now →</button>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
<script>
  window.SUPABASE_URL      = "SUPABASE_URL_PLACEHOLDER";
  window.SUPABASE_ANON_KEY = "SUPABASE_ANON_KEY_PLACEHOLDER";
</script>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>window.RAZORPAY_KEY_ID = "RAZORPAY_PUB_KEY_PLACEHOLDER";</script>
<script src="/js/cart.js"></script>
<script src="/js/checkout.js"></script>
<script src="/js/auth.js"></script>
<script>
const BOOKS = BOOKS_DATA_PLACEHOLDER;
const SOCIAL_PROOF = SOCIAL_PROOF_PLACEHOLDER;

// ── Lookup book by slug ───────────────────────────────────────────────────
const BOOK_MAP = {};
BOOKS.forEach(b => { BOOK_MAP[b.slug] = b; });

function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function pricePaise(priceStr){ return Math.round(parseFloat((priceStr||'').replace(/[^0-9.]/g,'')||0)); }

function priceToText(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? '₹ ' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '';
}

function applyProductOverride(book, override) {
  if (!book || !override) return book;
  const next = { ...book };
  if (override.title) next.t = override.title;
  if (override.author) next.a = override.author;
  if (override.category) {
    next.cat = override.category;
    next.tab = override.category;
  }
  if (override.price_inr !== null && override.price_inr !== undefined) next.p = priceToText(override.price_inr);
  if (override.original_price_inr !== null && override.original_price_inr !== undefined) next.op = priceToText(override.original_price_inr);
  return next;
}

function customProductToBook(product) {
  if (!product || !product.slug || !product.title) return null;
  return {
    t: product.title || '',
    a: product.author || '',
    p: priceToText(product.price_inr),
    op: priceToText(product.original_price_inr),
    img: product.image_url || '/images/og-default.jpg',
    back_img: '',
    url: '/product/' + product.slug + '/',
    slug: product.slug,
    cat: product.category || 'Books',
    tab: product.category || 'Books',
    desc: product.description || '',
    isbn: product.isbn || '',
    pub: product.publisher || 'Ink & Chai',
    n: 1,
    ts: product.updated_at || new Date().toISOString(),
    pdf: '',
    pdf_pages: 0,
    rating: '',
    review_count: '',
    order_badge: '',
    review_image: '',
    review_video: '',
    reviews: [],
    custom: true,
  };
}

async function loadSingleProductOverride(slug) {
  try {
    const res = await fetch('/.netlify/functions/get-product-overrides', { cache: 'no-store' });
    if (!res.ok) return { override: null, customProduct: null };
    const data = await res.json();
    const key = String(slug || '').toLowerCase();
    const override = (data.overrides || []).find(o => String(o.slug || '').toLowerCase() === key) || null;
    const customProduct = (data.custom_products || []).find(o => String(o.slug || '').toLowerCase() === key) || null;
    return { override, customProduct };
  } catch (err) {
    console.warn('Product override unavailable:', err.message);
    return { override: null, customProduct: null };
  }
}

// ── Render product page ───────────────────────────────────────────────────
function renderProduct(b) {
  const pageTitle = b.t + (b.a ? ' by ' + b.a : '') + ' — Buy Online at Ink & Chai';
  const shortDesc = (b.desc || '').slice(0, 250) || ('Buy ' + b.t + (b.a ? ' by ' + b.a : '') + ' online at Ink & Chai. Fast pan-India delivery, free shipping above ₹499, 7-day easy returns.');
  const canonical = 'https://inkandchai.in/product/' + b.slug + '/';
  const imgAbs = (b.img || '').startsWith('http') ? b.img : ('https://inkandchai.in' + (b.img || ''));

  document.title = pageTitle;
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) metaDesc.content = shortDesc;
  // Update keywords meta with author + category for category-specific SEO
  const metaKw = document.querySelector('meta[name="keywords"]');
  if (metaKw) metaKw.content = [b.t, b.a, b.cat, 'buy online india', 'free shipping', 'ink and chai'].filter(Boolean).join(', ');

  // Open Graph + Twitter
  const setMeta = (id, val) => { const el = document.getElementById(id); if (el) el.setAttribute('content', val); };
  setMeta('ogTitle', pageTitle);
  setMeta('ogDesc',  shortDesc);
  setMeta('ogImg',   imgAbs);
  setMeta('ogUrl',   canonical);
  setMeta('twTitle', pageTitle);
  setMeta('twDesc',  shortDesc);
  setMeta('twImg',   imgAbs);
  const canon = document.getElementById('canonLink'); if (canon) canon.href = canonical;

  // JSON-LD structured data — Google rich-snippet for Product + Breadcrumbs
  const _sale = parseFloat((b.p||'').replace(/[^0-9.]/g,'')||0);
  const _orig = parseFloat((b.op||'').replace(/[^0-9.]/g,'')||0);
  const _rating = parseFloat(b.rating || '4.7') || 4.7;
  const _reviewCount = parseInt(b.review_count || '128', 10) || 128;
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Book",
        "@id": canonical + '#book',
        "name": b.t,
        "author": { "@type": "Person", "name": b.a || "Various" },
        "image": imgAbs,
        "description": shortDesc,
        "isbn": b.isbn || undefined,
        "publisher": b.pub || "Ink & Chai",
        "inLanguage": (b.t && /हिं|हि|—\\s*[ऀ-ॿ]/.test(b.t)) ? "hi" : "en",
        "url": canonical,
        "bookFormat": "https://schema.org/Paperback",
        "offers": {
          "@type": "Offer",
          "priceCurrency": "INR",
          "price": _sale,
          "priceValidUntil": new Date(Date.now() + 365*24*60*60*1000).toISOString().slice(0,10),
          "availability": "https://schema.org/InStock",
          "itemCondition": "https://schema.org/NewCondition",
          "url": canonical,
          "seller": { "@type": "Organization", "name": "Ink & Chai", "url": "https://inkandchai.in" },
          "shippingDetails": {
            "@type": "OfferShippingDetails",
            "shippingRate": { "@type": "MonetaryAmount", "value": _sale >= 499 ? 0 : 40, "currency": "INR" },
            "shippingDestination": { "@type": "DefinedRegion", "addressCountry": "IN" },
            "deliveryTime": { "@type": "ShippingDeliveryTime", "businessDays": { "@type": "QuantitativeValue", "minValue": 2, "maxValue": 5 } }
          }
        },
        "aggregateRating": {
          "@type": "AggregateRating",
          "ratingValue": _rating.toFixed(1),
          "reviewCount": String(_reviewCount)
        }
      },
      {
        "@type": "BreadcrumbList",
        "itemListElement": [
          { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://inkandchai.in/" },
          { "@type": "ListItem", "position": 2, "name": b.cat || "Books", "item": "https://inkandchai.in/category/?name=" + encodeURIComponent(b.cat || "") },
          { "@type": "ListItem", "position": 3, "name": b.t, "item": canonical }
        ]
      }
    ]
  };
  const ldEl = document.getElementById('ldjson');
  if (ldEl) ldEl.textContent = JSON.stringify(ld);

  // Savings
  const sale = parseFloat((b.p||'').replace(/[^0-9.]/g,'')||0);
  const orig = parseFloat((b.op||'').replace(/[^0-9.]/g,'')||0);
  const savePct = (orig > sale && orig > 0) ? Math.round((orig - sale)/orig*100) : 0;

  const shareUrl = window.location.href;

  document.getElementById('productContent').innerHTML = `
    <div class="product-page">
      <!-- LEFT: cover -->
      <div class="prod-cover-wrap">
        <div class="prod-cover">
          ${b.img
            ? `<img src="${esc(b.img)}" alt="${esc(b.t)} — ${esc(b.a||'book')} cover" loading="eager" fetchpriority="high" decoding="async" onclick="openLightbox(this.src, this.alt)" />`
            : `<div class="prod-cover-placeholder"></div>`}
        </div>
        ${b.back_img ? `
          <div class="prod-cover-secondary">
            <img src="${esc(b.back_img)}" alt="${esc(b.t)} back cover" loading="lazy" decoding="async" onclick="openLightbox(this.src, this.alt)" />
          </div>` : ''}
        ${b.pdf ? `
          <div class="sample-pdf-row">
            <a class="btn-sample-pdf" href="${esc(b.pdf)}" data-pdf="${esc(b.pdf)}" data-title="${esc(b.t)}" onclick="openSamplePdf(this.dataset.pdf, this.dataset.title); return false;" target="_blank" rel="noopener" title="Read first ${b.pdf_pages || 'few'} pages free">
              <span class="ic">📖</span><span>Read inside · Free Sample${b.pdf_pages ? ` (${b.pdf_pages} pages)` : ''}</span>
            </a>
          </div>` : ''}
        <div class="prod-badges">
          <span class="badge">${esc(b.cat)}</span>
          ${savePct ? `<span class="badge sale">Save ${savePct}%</span>` : ''}
        </div>
      </div>

      <!-- RIGHT: info -->
      <div class="prod-info">
        <div class="prod-breadcrumb">
          <a href="/">Home</a> &nbsp;/&nbsp;
          <a href="/?cat=${encodeURIComponent(b.cat)}">${esc(b.cat)}</a> &nbsp;/&nbsp;
          ${esc(b.t)}
        </div>

        <h1 class="prod-title">${esc(b.t)}</h1>
        ${b.a ? `<div class="prod-author">by <span>${esc(b.a)}</span></div>` : ''}
        ${b.order_badge ? `<div class="prod-order-badge">🔥 ${esc(b.order_badge)}</div>` : ''}
        <div class="prod-rating">
          <span class="prod-stars">★★★★★</span>
          <span class="prod-rating-label">${b.rating && b.review_count ? `${esc(b.rating)} rating · ${esc(String(b.review_count))} customer reviews` : 'Bestseller · Loved by readers across India'}</span>
        </div>

        <div class="divider"></div>

        <div class="prod-price-row">
          <span class="prod-price">${esc(b.p)}</span>
          ${b.op ? `<span class="prod-orig">${esc(b.op)}</span>` : ''}
          ${savePct ? `<span class="prod-saving">Save ${savePct}%</span>` : ''}
        </div>

        ${sale >= 299 && Date.now() < new Date('2026-05-19T18:30:00Z').getTime() ? `
        <div class="prod-sale-box">
          <div class="prod-sale-box-head">☀️ Summer Sale Price</div>
          <span class="prod-sale-price">₹${Math.round(sale * 0.9).toLocaleString('en-IN')}</span>
          <span class="prod-sale-saving">You save ₹${Math.round(sale * 0.1).toLocaleString('en-IN')} (10%)</span>
          <div class="prod-sale-code">Use code <strong onclick="navigator.clipboard?.writeText('SUMMER10');this.textContent='✓ Copied!';setTimeout(()=>this.textContent='SUMMER10',2000)" title="Click to copy">SUMMER10</strong> at checkout</div>
          <div class="prod-sale-timer" style="margin-top:0.5rem;">
            <span class="prod-cd-label">Ends in</span>
            <div class="prod-cd" id="prodCountdown"></div>
          </div>
        </div>` : ''}

        <div class="prod-trust-row" aria-label="Purchase benefits">
          <span>🚚 2–5 day delivery</span>
          <span>💵 COD available</span>
          <span>💳 UPI/cards</span>
          <span>🛡 7-day replacement</span>
        </div>

        ${b.desc ? `
          <div>
            <div class="prod-desc-title">About this book</div>
            <p class="prod-desc" id="descText">${esc(b.desc)}</p>
          </div>` : ''}

        <div class="prod-meta-grid">
          ${b.cat  ? `<div class="prod-meta-item"><div class="prod-meta-label">Category</div><div class="prod-meta-val">${esc(b.cat)}</div></div>` : ''}
          ${b.a    ? `<div class="prod-meta-item"><div class="prod-meta-label">Author</div><div class="prod-meta-val">${esc(b.a)}</div></div>` : ''}
          ${b.pub  ? `<div class="prod-meta-item"><div class="prod-meta-label">Publisher</div><div class="prod-meta-val">${esc(b.pub)}</div></div>` : ''}
          ${b.isbn ? `<div class="prod-meta-item"><div class="prod-meta-label">ISBN</div><div class="prod-meta-val">${esc(b.isbn)}</div></div>` : ''}
          <div class="prod-meta-item"><div class="prod-meta-label">Delivery</div><div class="prod-meta-val">Pan-India · 2–5 days</div></div>
          <div class="prod-meta-item"><div class="prod-meta-label">Returns</div><div class="prod-meta-val">7-day easy returns</div></div>
          <div class="prod-meta-item"><div class="prod-meta-label">Payment</div><div class="prod-meta-val">COD · UPI · Cards</div></div>
          <div class="prod-meta-item"><div class="prod-meta-label">Sold by</div><div class="prod-meta-val">Ink &amp; Chai</div></div>
        </div>

        <div class="divider"></div>

        <div class="qty-row">
          <span class="qty-label">Quantity</span>
          <div class="qty-ctrl">
            <button onclick="adjQty(-1)" aria-label="decrease quantity">−</button>
            <div class="qty-num" id="prodQty">1</div>
            <button onclick="adjQty(1)" aria-label="increase quantity">+</button>
          </div>
        </div>

        <div class="prod-actions">
          <button class="btn-cart" data-slug="${esc(b.slug)}" onclick="addBookToCart(this.dataset.slug, this)">
            + Add to Cart
          </button>
          <button class="btn-cod" data-slug="${esc(b.slug)}" onclick="buyNowBook(this.dataset.slug, this)">
            ⚡ Buy Now — ${esc(b.p)}
          </button>
          <div style="display:flex;gap:0.6rem;margin-top:0.2rem">
            <button class="btn-share" onclick="shareBook()">↗ Share</button>
            <button id="prodWishBtn"
              onclick="if(window.toggleWishlist){ toggleWishlist({url:'${esc(b.url)}',title:'${esc(b.t).replace(/'/g,'\\u0027')}',img:'${esc(b.img)}',price:${sale}}); updateProdWishBtn(); }"
              class="btn-share" title="Save to wishlist">♡ Wishlist</button>
          </div>
        </div>

        <div class="promise-box">
          <div class="promise-box-title">🛡 Ink &amp; Chai Promise</div>
          <div class="promise-box-text">Get a <strong>free replacement</strong> if you receive a damaged, misprinted, or wrong book — no questions asked. Reply to your order email within 24 hours of delivery.</div>
        </div>

        ${b.review_count ? `
        <section class="review-panel" aria-label="Customer reviews">
          <div class="review-head">
            <div>
              <div class="review-kicker">Reader reviews</div>
              <div class="review-title">Trusted by readers across India</div>
            </div>
            <div class="review-score">
              <strong>${esc(b.rating || '4.6')}</strong>
              <span>${esc(String(b.review_count))} reviews</span>
            </div>
          </div>
          <div class="prod-stars" aria-label="${esc(b.rating || '4.6')} out of 5 stars">★★★★★</div>
          ${(b.review_image || b.review_video) ? `
          <div class="review-media">
            ${b.review_image ? `<figure><img src="${esc(b.review_image)}" alt="${esc(b.t)} customer review photo" loading="lazy" onclick="openLightbox(this.src, this.alt)" /><figcaption>Customer photo shared after delivery</figcaption></figure>` : ''}
            ${b.review_video ? `<figure><video src="${esc(b.review_video)}" controls playsinline preload="metadata"></video><figcaption>Customer video review / unboxing</figcaption></figure>` : ''}
          </div>` : ''}
          <p class="review-note">Readers choose Ink &amp; Chai for fast delivery, careful packing and checkout-backed order updates.</p>
        </section>` : ''}
      </div>
    </div>

    <!-- Mobile sticky bottom bar (shown only on mobile via CSS) -->
    <div class="prod-bottom-bar">
      <button class="pbb-cart" data-slug="${esc(b.slug)}" onclick="addBookToCart(this.dataset.slug, this)">
        + Add to Cart
      </button>
      <button class="pbb-buy" data-slug="${esc(b.slug)}" onclick="buyNowBook(this.dataset.slug, this)">
        Buy Now · ${esc(b.p)}
      </button>
    </div>
  `;
  // Set initial wishlist state
  setTimeout(updateProdWishBtn, 100);

  // Product page sale countdown
  const _saleEnd = new Date('2026-05-19T18:30:00Z');
  function _tickProd() {
    const el = document.getElementById('prodCountdown');
    if (!el) return;
    const diff = _saleEnd.getTime() - Date.now();
    if (diff <= 0) { el.closest('.prod-sale-box')?.remove(); return; }
    const d = Math.floor(diff / 86400000);
    const h = String(Math.floor((diff % 86400000) / 3600000)).padStart(2,'0');
    const m = String(Math.floor((diff % 3600000) / 60000)).padStart(2,'0');
    const s = String(Math.floor((diff % 60000) / 1000)).padStart(2,'0');
    el.innerHTML =
      `<div class="prod-cd-block"><span class="prod-cd-num">${d}</span><span class="prod-cd-lbl">d</span></div>` +
      `<span class="prod-cd-sep">:</span>` +
      `<div class="prod-cd-block"><span class="prod-cd-num">${h}</span><span class="prod-cd-lbl">h</span></div>` +
      `<span class="prod-cd-sep">:</span>` +
      `<div class="prod-cd-block"><span class="prod-cd-num">${m}</span><span class="prod-cd-lbl">m</span></div>` +
      `<span class="prod-cd-sep">:</span>` +
      `<div class="prod-cd-block"><span class="prod-cd-num">${s}</span><span class="prod-cd-lbl">s</span></div>`;
  }
  if (Date.now() < _saleEnd.getTime()) {
    _tickProd();
    const _prodTimer = setInterval(() => { if (!document.getElementById('prodCountdown')) { clearInterval(_prodTimer); return; } _tickProd(); }, 1000);
  }
}

function updateProdWishBtn() {
  const btn = document.getElementById('prodWishBtn');
  if (!btn) return;
  const bookUrl = book ? book.url : '';
  const wished = window.isWishlisted ? isWishlisted(bookUrl) : false;
  btn.innerHTML = wished ? '♥ Wishlisted' : '♡ Save to Wishlist';
  btn.style.color = wished ? '#e05050' : '#a09080';
  btn.style.borderColor = wished ? 'rgba(224,80,80,0.4)' : 'rgba(201,168,76,0.3)';
}

function shareBook() {
  if (navigator.share) {
    navigator.share({ title: document.title, url: window.location.href });
  } else {
    navigator.clipboard.writeText(window.location.href)
      .then(() => showToast('Link copied!'));
  }
}

// ── Frequently Bought Together ────────────────────────────────────────────
// Picks 2-3 smart companions and shows them with checkboxes + bundle price.
function renderFBT(b) {
  const stop = new Set(['the','and','with','for','book','books','edition','paperback','by','of','a','an']);
  const tokens = value => new Set(String(value || '').toLowerCase().replace(/[^a-z0-9\\u0900-\\u097f]+/g,' ').split(/\\s+/).filter(w => w.length > 2 && !stop.has(w)));
  const baseWords = tokens(`${b.t} ${b.a || ''} ${b.cat || ''} ${b.desc || ''}`);
  const baseCat = String(b.cat || '').toLowerCase();
  const baseAuthor = String(b.a || '').toLowerCase();
  const hash = value => String(value || '').split('').reduce((a, c) => ((a * 31) + c.charCodeAt(0)) >>> 0, 7);
  const score = x => {
    let s = 0;
    const cat = String(x.cat || '').toLowerCase();
    const author = String(x.a || '').toLowerCase();
    if (baseCat && cat && baseCat === cat) s += 70;
    if (baseCat.includes('hindi') && cat.includes('hindi')) s += 18;
    if (baseCat.includes('romance') && cat.includes('romance')) s += 16;
    if (baseCat.includes('self') && cat.includes('self')) s += 16;
    if (baseAuthor && author && baseAuthor === author) s += 55;
    const words = tokens(`${x.t} ${x.a || ''} ${x.cat || ''} ${x.desc || ''}`);
    let overlap = 0;
    baseWords.forEach(w => { if (words.has(w)) overlap++; });
    s += Math.min(overlap * 8, 48);
    const bp = parseFloat((b.p || '').replace(/[^0-9.]/g,'')) || 0;
    const xp = parseFloat((x.p || '').replace(/[^0-9.]/g,'')) || 0;
    const diff = Math.abs(bp - xp);
    s += diff <= 75 ? 14 : diff <= 175 ? 8 : diff <= 350 ? 3 : 0;
    if (/combo|set|series|bestseller|trending|hindi|self help|romance/i.test(`${x.t} ${x.cat}`)) s += 7;
    return s + (hash(`${b.slug}:${x.slug}`) % 11);
  };
  const pair = BOOKS
    .filter(x => x.slug !== b.slug && x.url !== b.url && x.img && x.p)
    .map(x => ({ x, s: score(x) }))
    .sort((a, c) => c.s - a.s)
    .slice(0, 3)
    .map(row => row.x);
  if (pair.length < 1) { document.getElementById('fbtContent').innerHTML = ''; return; }

  // Stash full items on window so the button handler can read them
  const items = [b, ...pair];
  window.__fbtItems = items;

  const priceOf = it => parseFloat((it.p || '').replace(/[^0-9.]/g, '')) || 0;
  const origOf  = it => parseFloat((it.op || '').replace(/[^0-9.]/g, '')) || 0;

  const rowHtml = (it, idx, isCurrent) => `
    <div class="fbt-row">
      <input type="checkbox" class="fbt-check" data-idx="${idx}" ${idx === 0 || true ? 'checked' : ''} onchange="updateFBTTotal()">
      <a class="fbt-thumb" href="${idx === 0 ? '#' : '/product/' + it.slug + '/'}" onclick="${idx === 0 ? 'event.preventDefault();' : ''}">
        <img src="${esc(it.img)}" alt="${esc(it.t)}" loading="lazy"/>
      </a>
      <div class="fbt-info" onclick="${idx === 0 ? '' : `location.href='/product/${it.slug}/'`}">
        <div class="fbt-name">${esc(it.t)}${isCurrent ? '<span class="fbt-current">This item</span>' : ''}</div>
        <div class="fbt-author">${esc(it.a || '')}</div>
      </div>
      <div class="fbt-pricecol">
        <span class="fbt-price">${esc(it.p)}</span>
        ${it.op ? `<span class="fbt-orig">${esc(it.op)}</span>` : ''}
      </div>
    </div>`;

  document.getElementById('fbtContent').innerHTML = `
    <section class="fbt">
      <h2 class="fbt-title">Frequently bought <em>together</em></h2>
      <div class="fbt-box">
        ${items.map((it, i) => rowHtml(it, i, i === 0)).join('')}
        <div class="fbt-summary">
          <div class="fbt-total">
            <span class="fbt-total-label">Bundle Total</span>
            <span class="fbt-total-amt" id="fbtTotal">₹ ${items.reduce((sum, it) => sum + priceOf(it), 0).toLocaleString('en-IN')}</span>
            <span class="fbt-total-orig" id="fbtTotalOrig"></span>
          </div>
          <button class="fbt-cta" onclick="addBundleToCart()">+ Add Bundle to Cart</button>
        </div>
      </div>
    </section>`;
  updateFBTTotal();
}

function updateFBTTotal() {
  const items = window.__fbtItems || [];
  const checks = document.querySelectorAll('.fbt-check');
  let total = 0, totalOrig = 0;
  checks.forEach(c => {
    if (c.checked) {
      const it = items[parseInt(c.dataset.idx)];
      if (!it) return;
      total     += parseFloat((it.p  || '').replace(/[^0-9.]/g, '')) || 0;
      totalOrig += parseFloat((it.op || '').replace(/[^0-9.]/g, '')) || 0;
    }
  });
  const amtEl  = document.getElementById('fbtTotal');
  const origEl = document.getElementById('fbtTotalOrig');
  if (amtEl)  amtEl.textContent  = '₹ ' + total.toLocaleString('en-IN');
  if (origEl) origEl.innerHTML   = (totalOrig > total) ? `₹ ${totalOrig.toLocaleString('en-IN')}` : '';
}

function addBundleToCart() {
  const items = window.__fbtItems || [];
  const checks = document.querySelectorAll('.fbt-check');
  let added = 0;
  const CART_KEY = 'akshar_cart';
  const cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
  checks.forEach(c => {
    if (!c.checked) return;
    const it = items[parseInt(c.dataset.idx)];
    if (!it) return;
    const price = parseFloat((it.p || '').replace(/[^0-9.]/g, '')) || 0;
    const id = it.url || it.slug;
    const existing = cart.find(x => x.id === id);
    if (existing) { existing.qty += 1; }
    else { cart.push({ id, title: it.t, author: it.a || '', price, img: it.img || '', url: it.url || '', qty: 1 }); }
    added++;
  });
  if (!added) { showToast?.('Select at least one book'); return; }
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  if (window.refreshCart) refreshCart();
  if (window.openCart)    openCart();
  if (window.showToast)   showToast(`${added} books added to cart 🎉`);
}

// ── #InkAndChaiBookstagram social proof strip ─────────────────────────────
// Reads from SOCIAL_PROOF (data/social_proof.json) — fed at build time. If
// the list is empty we still render a tiny "coming soon" line so customers
// know to look here, but no fake content.
function renderBookstagram() {
  const el = document.getElementById('bookstagramContent');
  if (!el) return;
  const items = (window.SOCIAL_PROOF || []).slice(0, 12);
  if (!items.length) {
    el.innerHTML = `
      <section class="bkg-section">
        <h2 class="bkg-title">#Ink<em>And</em>ChaiBookstagram</h2>
        <div class="bkg-sub">Real customers · Real unboxings</div>
        <div class="bkg-empty">
          We're collecting unboxing photos and reels from our readers. Tag <code>@inkandchai</code> on Instagram and your post might land here.
        </div>
      </section>`;
    return;
  }
  const cards = items.map((it, i) => {
    const isVideo = (it.type || '').toLowerCase() === 'video' || /\\.(mp4|webm|mov)$/i.test(it.src || '');
    const igChip = it.instagram
      ? `<a class="bkg-ig-chip" href="${esc(it.instagram)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">↗ Instagram</a>`
      : '';
    const cap = it.caption ? `<div class="bkg-overlay">${esc(it.caption)}</div>` : '';
    if (isVideo) {
      const poster = it.poster ? ` poster="${esc(it.poster)}"` : '';
      return `
        <div class="bkg-card is-playing" onclick="bkgPlay(this)">
          <video src="${esc(it.src)}"${poster} autoplay muted playsinline loop preload="auto"></video>
          <div class="bkg-play">▶</div>
          ${igChip}${cap}
        </div>`;
    }
    return `
      <div class="bkg-card" ${it.instagram ? `onclick="window.open('${esc(it.instagram)}','_blank')"` : ''}>
        <img src="${esc(it.src)}" alt="${esc(it.caption || 'Customer photo')}" loading="lazy"/>
        ${igChip}${cap}
      </div>`;
  }).join('');
  el.innerHTML = `
    <section class="bkg-section">
      <h2 class="bkg-title">#Ink<em>And</em>ChaiBookstagram</h2>
      <div class="bkg-sub">Real customers · Real unboxings · Real reads</div>
      <div class="bkg-strip">${cards}</div>
    </section>`;
}
window.bkgPlay = function(card) {
  const v = card.querySelector('video');
  if (!v) return;
  if (v.paused) { v.play().then(() => card.classList.add('is-playing')).catch(()=>{}); }
  else          { v.pause(); card.classList.remove('is-playing'); }
};

// Auto-mark cards whose video is already playing (autoplay case)
document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('.bkg-card video').forEach(function(v) {
    if (!v.paused) v.closest('.bkg-card')?.classList.add('is-playing');
    v.addEventListener('play', function() { v.closest('.bkg-card')?.classList.add('is-playing'); });
    v.addEventListener('pause', function() { v.closest('.bkg-card')?.classList.remove('is-playing'); });
  });
});

// Expose social-proof JSON to renderer
window.SOCIAL_PROOF = SOCIAL_PROOF;

// ── Related books — scored by author › category › tab ────────────────────
function renderRelated(b) {
  // Score every book that isn't the current one
  const authorNorm = (b.a || '').toLowerCase().trim();
  const scored = BOOKS
    .filter(x => x.url !== b.url && x.slug !== b.slug)
    .map(x => {
      let score = 0;
      const xAuthor = (x.a || '').toLowerCase().trim();
      // Same author — strongest signal (catches series books)
      if (xAuthor && xAuthor === authorNorm) score += 8;
      // Partial author match (shared word — e.g. both "Ana Huang" books)
      else if (authorNorm && xAuthor) {
        const aParts = authorNorm.split(/\s+/);
        const xParts = xAuthor.split(/\s+/);
        if (aParts.some(w => w.length > 2 && xParts.includes(w))) score += 3;
      }
      // Same category
      if (x.cat && x.cat === b.cat) score += 4;
      // Same broad tab (Fiction / Non-Fiction / Hindi / etc.)
      if (x.tab && x.tab === b.tab) score += 1;
      // Slight preference for books with images & reviews
      if (x.img) score += 0.5;
      return { x, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ x }) => x);

  // Fallback: same category if no author matches at all
  const pool = scored.length >= 3 ? scored
    : BOOKS.filter(x => x.cat === b.cat && x.url !== b.url && x.slug !== b.slug).slice(0, 6);

  if (!pool.length) return;

  const heading = scored.length && scored[0].a === b.a
    ? `More by <em>${esc(b.a)}</em>`
    : `You May Also <em>Like</em>`;

  document.getElementById('relatedContent').innerHTML = `
    <div class="related">
      <h2 class="related-title">${heading}</h2>
      <div class="related-grid">
        ${pool.map(r => `
          <a class="rel-card" href="/product/${r.slug}/" style="text-decoration:none;display:block">
            <div class="rel-cover">
              ${r.img ? `<img src="${esc(r.img)}" alt="${esc(r.t)}" loading="lazy"/>` : ''}
            </div>
            <div class="rel-title">${esc(r.t)}</div>
            <div class="rel-author">${esc(r.a || '')}</div>
            <div class="rel-price">${esc(r.p)}</div>
          </a>`).join('')}
      </div>
    </div>
  `;
}

// ── Safe cart helper (avoids quoting issues in inline onclick) ────────────
// Quantity selector helpers
function getQty() {
  return Math.max(1, parseInt(document.getElementById('prodQty')?.textContent || '1') || 1);
}
function adjQty(d) {
  const el = document.getElementById('prodQty');
  if (!el) return;
  el.textContent = Math.max(1, Math.min(10, (parseInt(el.textContent) || 1) + d));
}

function buttonLoading(btn, on) {
  if (!btn) return;
  btn.classList.toggle('is-loading', !!on);
  btn.disabled = !!on;
}

function cartItemForBook(b, bookSlug, qty) {
  const price = parseFloat((b.p||'').replace(/[^0-9.]/g,'')) || 0;
  return { id: b.url || bookSlug, title: b.t, author: b.a||'', price, img: b.img||'', url: b.url||'', qty };
}

function addBookToCart(bookSlug, trigger) {
  const b = BOOK_MAP[bookSlug];
  if (!b) return;
  buttonLoading(trigger, true);
  localStorage.removeItem('iac_buy_now_cart');
  const item  = cartItemForBook(b, bookSlug, getQty());
  const qty   = getQty();
  // Directly write to localStorage to support qty > 1
  const CART_KEY = 'akshar_cart';
  const cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
  const existing = cart.find(i => i.id === item.id);
  if (existing) { existing.qty += qty; } else { cart.push({ ...item, qty }); }
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  if (window.refreshCart) refreshCart();
  setTimeout(() => {
    buttonLoading(trigger, false);
    if (window.openCart)    openCart();
    if (window.showToast)   showToast(`${qty > 1 ? qty + '× ' : ''}"${item.title.slice(0,28)}…" added to cart`);
  }, 220);
}

function buyNowBook(bookSlug, trigger) {
  const b = BOOK_MAP[bookSlug];
  if (!b) return;
  buttonLoading(trigger, true);
  localStorage.setItem('iac_buy_now_cart', JSON.stringify([cartItemForBook(b, bookSlug, getQty())]));
  setTimeout(() => { window.location.href = '/checkout/'; }, 260);
}

// ── Init ──────────────────────────────────────────────────────────────────
const params  = new URLSearchParams(window.location.search);
const pathParts = window.location.pathname.split('/').filter(Boolean);
const pathSlug = pathParts[0] === 'product' && pathParts[1] ? pathParts[1] : '';
const slug    = params.get('id') || pathSlug;

(async () => {
  const foundBook = slug ? BOOK_MAP[slug] : null;
  const liveData = slug ? await loadSingleProductOverride(slug) : { override: null, customProduct: null };
  const book = foundBook || customProductToBook(liveData.customProduct);
  if (book) {
    const liveBook = applyProductOverride(book, liveData.override);
    renderProduct(liveBook);
    renderFBT(liveBook);
    renderBookstagram();
    renderRelated(liveBook);
  } else {
    document.getElementById('productContent').innerHTML = `
      <div class="not-found">
        <h2>Book not found</h2>
        <p>This page may have moved. <a href="/" style="color:var(--gold)">Browse all books →</a></p>
      </div>`;
  }
})();
</script>
</body>
</html>
"""

# Social proof items — fed into every product page's #InkAndChaiBookstagram strip
try:
    _social = json.loads((Path(__file__).parent / "data" / "social_proof.json").read_text())
    social_items = [it for it in (_social.get("items") or []) if isinstance(it, dict) and it.get("src")]
except Exception:
    social_items = []
print(f"Social-proof items: {len(social_items)}")

PRODUCT_HTML = PRODUCT_HTML.replace("BOOKS_DATA_PLACEHOLDER",        books_js)
PRODUCT_HTML = PRODUCT_HTML.replace("SOCIAL_PROOF_PLACEHOLDER",      json.dumps(social_items, ensure_ascii=False))
PRODUCT_HTML = PRODUCT_HTML.replace("RAZORPAY_PUB_KEY_PLACEHOLDER",  razorpay_key)
PRODUCT_HTML = PRODUCT_HTML.replace("SUPABASE_URL_PLACEHOLDER",      os.environ.get("SUPABASE_URL", ""))
PRODUCT_HTML = PRODUCT_HTML.replace("SUPABASE_ANON_KEY_PLACEHOLDER", os.environ.get("SUPABASE_ANON_KEY", ""))
PRODUCT_HTML = with_reader_activity(PRODUCT_HTML)
PRODUCT_HTML = with_meta_pixel(PRODUCT_HTML)

prod_out = Path(__file__).parent / "public" / "product" / "index.html"
prod_out.parent.mkdir(parents=True, exist_ok=True)
prod_out.write_text(PRODUCT_HTML, encoding="utf-8")
print(f"Generated: {prod_out}  ({len(PRODUCT_HTML.encode())//1024} KB)")
print(f"Books embedded: {len(slim)}")

# ── Crawlable Product + SEO Landing Pages ────────────────────────────────────
def price_number(book):
    try:
        return float((book.get("p") or "").replace("₹", "").replace(",", "").strip())
    except Exception:
        return 0.0

def absolute_img(book):
    img = book.get("img") or ""
    return img if img.startswith("http") else f"https://inkandchai.in{img}"

def absolute_back_img(book):
    img = book.get("back_img") or ""
    if not img:
        return ""
    return img if img.startswith("http") else f"https://inkandchai.in{img}"

def book_description(book, limit=None):
    desc = (book.get("desc") or "").strip()
    if not desc:
        author = f" by {book.get('a')}" if book.get("a") else ""
        desc = f"Buy {book.get('t','this book')}{author} online at Ink & Chai with pan-India delivery, COD, UPI, cards, and 7-day replacement support."
    if limit and len(desc) > limit:
        clipped = desc[:limit].rsplit(" ", 1)[0].rstrip(".,;:—- ")
        return f"{clipped}..."
    return desc

def is_hindi_book(book):
    hay = f"{book.get('t','')} {book.get('cat','')}".lower()
    return "hindi" in hay or bool(re.search(r"[\u0900-\u097f]", book.get("t", "")))

def product_json_ld(book):
    price = price_number(book)
    canonical = product_abs_url(book["slug"])
    rating_value = book.get("rating") or book.get("rating_value")
    review_count = book.get("review_count")
    ld = {
        "@context": "https://schema.org",
        "@type": "Book",
        "name": book.get("t", ""),
        "author": {"@type": "Person", "name": book.get("a") or "Various"},
        "image": absolute_img(book),
        "description": book_description(book),
        "isbn": book.get("isbn") or None,
        "publisher": book.get("pub") or "Ink & Chai",
        "inLanguage": "hi" if is_hindi_book(book) else "en",
        "bookFormat": "https://schema.org/Paperback",
        "url": canonical,
        "offers": {
            "@type": "Offer",
            "url": canonical,
            "priceCurrency": "INR",
            "price": price,
            "availability": "https://schema.org/InStock",
            "itemCondition": "https://schema.org/NewCondition",
            "seller": {"@type": "Organization", "name": "Ink & Chai"},
            "shippingDetails": {
                "@type": "OfferShippingDetails",
                "shippingRate": {"@type": "MonetaryAmount", "value": 0 if price >= 499 else 40, "currency": "INR"},
                "shippingDestination": {"@type": "DefinedRegion", "addressCountry": "IN"},
                "deliveryTime": {"@type": "ShippingDeliveryTime", "businessDays": {"@type": "QuantitativeValue", "minValue": 2, "maxValue": 5}},
            },
            "hasMerchantReturnPolicy": {
                "@type": "MerchantReturnPolicy",
                "applicableCountry": "IN",
                "returnPolicyCategory": "https://schema.org/MerchantReturnFiniteReturnWindow",
                "merchantReturnDays": 7,
                "returnMethod": "https://schema.org/ReturnByMail",
            },
        },
    }
    # Per-product reviews → AggregateRating + Review nodes (Google rich snippets).
    # Prefer the structured `reviews` list when present (richer schema); fall back
    # to the codex-added `rating_value` + `review_count` manual summary.
    reviews = book.get("reviews") or []
    if reviews:
        ratings = [int(r.get("rating") or 5) for r in reviews]
        avg = sum(ratings) / len(ratings)
        ld["aggregateRating"] = {
            "@type": "AggregateRating",
            "ratingValue": str(rating_value or round(avg, 1)),
            "reviewCount": str(review_count or len(reviews)),
            "bestRating": 5,
        }
        ld["review"] = [
            {
                "@type": "Review",
                "author": {"@type": "Person", "name": r.get("name") or "Verified Buyer"},
                "reviewRating": {"@type": "Rating", "ratingValue": int(r.get("rating") or 5), "bestRating": 5},
                "reviewBody": r.get("text") or "",
            } for r in reviews
        ]
    elif rating_value and review_count:
        ld["aggregateRating"] = {
            "@type": "AggregateRating",
            "ratingValue": str(rating_value),
            "reviewCount": str(review_count),
        }
    return json.dumps(ld, ensure_ascii=False).replace("</", "<\\/")

def related_books_for(book, count=6):
    """Return up to `count` related books scored by author › category › tab."""
    current_url  = book.get("url", "")
    current_slug = book.get("slug", "")
    author_norm  = (book.get("a") or "").lower().strip()
    cat          = book.get("cat", "")
    tab          = book.get("tab", "")

    def score(b):
        s = 0
        ba = (b.get("a") or "").lower().strip()
        # Exact same author — strongest signal (catches series)
        if ba and ba == author_norm: s += 8
        elif author_norm and ba:
            # Partial author match (shared meaningful word)
            a_words = set(w for w in author_norm.split() if len(w) > 2)
            b_words = set(w for w in ba.split() if len(w) > 2)
            if a_words & b_words: s += 3
        if b.get("cat") == cat: s += 4
        if b.get("tab") == tab: s += 1
        if b.get("img"): s += 0.5
        return s

    candidates = [
        b for b in slim
        if b.get("url") != current_url and b.get("slug") != current_slug
    ]
    scored = sorted(candidates, key=score, reverse=True)
    # Keep only books with at least a minimal relevance score
    filtered = [b for b in scored if score(b) > 0]
    # Fallback to same category when nothing scores
    if len(filtered) < 3:
        filtered = [b for b in candidates if b.get("cat") == cat]
    return filtered[:count]


def static_product_html(book):
    title = html_escape(book.get("t", "Book"))
    author = html_escape(book.get("a") or "Various")
    cat = html_escape(book.get("cat") or "Books")
    price = html_escape(book.get("p") or "")
    orig = html_escape(book.get("op") or "")
    desc = html_escape(book_description(book))
    canonical = product_abs_url(book["slug"])
    img = html_escape(absolute_img(book))
    back_img = html_escape(absolute_back_img(book))
    static_cover_class = "cover cover-gallery" if back_img else "cover"
    static_back_cover = f'<img src="{back_img}" alt="{title} back cover" loading="lazy" onclick="openLB(this.src,this.alt)" style="cursor:zoom-in"/>' if back_img else ""
    sample_pdf = book.get("pdf") or ""
    sample_pdf_pages = book.get("pdf_pages") or 0
    rating = html_escape(str(book.get("rating") or book.get("rating_value") or ""))
    review_count = html_escape(str(book.get("review_count") or ""))
    order_badge = html_escape(book.get("order_badge") or "")
    review_image = html_escape(book.get("review_image") or book.get("review_image_url") or "")
    review_video = html_escape(book.get("review_video") or book.get("review_video_url") or "")
    review_media_html = ""
    if review_count and (review_image or review_video):
        review_media_html = (
            '<div class="review-media">'
            + (f'<figure><img src="{review_image}" alt="{title} customer review photo" loading="lazy" onclick="openLB(this.src,this.alt)" style="cursor:zoom-in"/><figcaption>Customer photo shared after delivery</figcaption></figure>' if review_image else "")
            + (f'<figure><video src="{review_video}" controls playsinline preload="metadata"></video><figcaption>Customer video review / unboxing</figcaption></figure>' if review_video else "")
            + '</div>'
        )
    review_html = ""
    if review_count:
        review_html = (
            f'<section class="reviews"><div class="review-head"><div><div class="label">Reader reviews</div>'
            f'<h2>Trusted by readers across India</h2></div><div class="score"><strong>{rating or "4.6"}</strong><span>{review_count} reviews</span></div></div>'
            f'<div class="stars" aria-label="{rating or "4.6"} out of 5 stars">★★★★★</div>{review_media_html}'
            f'<p>Readers choose Ink &amp; Chai for fast delivery, careful packing and checkout-backed order updates.</p></section>'
        )
    order_badge_html = f'<div class="order-badge">🔥 {order_badge}</div>' if order_badge else ""
    rating_line_html = f'<div class="rating-line"><span class="stars">★★★★★</span><span>{rating} rating · {review_count} customer reviews</span></div>' if review_count else ""
    sample_pdf_html = ""
    if sample_pdf:
        pages_label = f" ({sample_pdf_pages} pages)" if sample_pdf_pages else ""
        sample_pdf_html = (
            f'<div style="margin-top:.9rem;text-align:center">'
            f'<a class="btn-sample" href="{html_escape(sample_pdf)}" '
            f'data-pdf="{html_escape(sample_pdf)}" data-title="{title}" '
            f'onclick="openPdf(this.dataset.pdf, this.dataset.title); return false;" '
            f'target="_blank" rel="noopener" '
            f'style="display:inline-flex;align-items:center;gap:.55rem;font:600 .62rem Montserrat,sans-serif;'
            f'letter-spacing:.18em;text-transform:uppercase;padding:.75rem 1.2rem;'
            f'background:rgba(138,106,31,.08);color:var(--gold);border:1px dashed rgba(138,106,31,.5);'
            f'cursor:pointer;text-decoration:none;transition:all .2s">'
            f'<span>📖</span><span>Read inside · Free Sample{pages_label}</span></a></div>'
        )
    cart_item = json.dumps({
        "id": book.get("url") or book.get("slug"),
        "url": book.get("url") or book.get("slug"),
        "title": book.get("t", ""),
        "author": book.get("a", ""),
        "price": price_number(book),
        "img": book.get("img", ""),
        "qty": 1,
    }, ensure_ascii=False).replace("</", "<\\/")

    # ── Customer reviews block (renders only when book has reviews) ──────
    reviews = book.get("reviews") or []
    reviews_html = ""
    if reviews:
        ratings = [int(r.get("rating") or 5) for r in reviews]
        avg = str(book.get("rating") or book.get("rating_value") or round(sum(ratings) / len(ratings), 1))
        displayed_review_count = str(book.get("review_count") or len(reviews))
        star_avg = float(avg) if str(avg).replace(".", "", 1).isdigit() else round(sum(ratings) / len(ratings), 1)
        full_stars = int(star_avg)
        half_star  = 1 if (star_avg - full_stars) >= 0.4 else 0
        empty_stars = 5 - full_stars - half_star
        stars_str = ("★" * full_stars) + ("⯨" * half_star) + ("☆" * empty_stars)
        review_cards = []
        for r in reviews:
            r_stars = "★" * int(r.get("rating") or 5) + "☆" * (5 - int(r.get("rating") or 5))
            initial = (r.get("name") or "?")[0].upper()
            review_cards.append(
                f'<article style="background:var(--panel);border:1px solid var(--border);padding:1.1rem 1.2rem">'
                f'<div style="display:flex;align-items:center;gap:.7rem;margin-bottom:.55rem">'
                f'<div style="width:34px;height:34px;border-radius:50%;background:rgba(201,168,76,.15);'
                f'color:var(--gold);display:flex;align-items:center;justify-content:center;font-weight:700;'
                f'font-family:Montserrat,sans-serif">{html_escape(initial)}</div>'
                f'<div style="flex:1;min-width:0"><div style="font-weight:600;color:var(--cream);font-size:.85rem">'
                f'{html_escape(r.get("name") or "Verified Buyer")}</div>'
                f'<div style="font-size:.6rem;letter-spacing:.18em;color:#5a4a38;text-transform:uppercase">'
                f'<span style="color:#c9a84c;letter-spacing:.05em;font-size:.85rem">{r_stars}</span>'
                f' &nbsp; ✓ Verified Buyer</div></div></div>'
                f'<div style="color:var(--cream);font-size:.85rem;line-height:1.7">{html_escape(r.get("text") or "")}</div>'
                f'</article>'
            )
        reviews_html = (
            f'<section style="max-width:1260px;margin:1.5rem auto 0;padding:0 1rem">'
            f'<div style="border-top:1px solid var(--border);padding-top:1.6rem">'
            f'<div style="display:flex;align-items:baseline;gap:.7rem;margin-bottom:1.1rem;flex-wrap:wrap">'
            f'<h2 style="font-family:\'Cormorant Garamond\',serif;font-size:1.6rem;font-weight:500;color:var(--cream);margin:0">'
            f'Customer Reviews</h2>'
            f'<span style="color:#c9a84c;font-size:1.1rem;letter-spacing:.05em">{stars_str}</span>'
            f'<span style="color:var(--muted);font-size:.78rem">{avg}/5 · {displayed_review_count} reviews</span>'
            f'</div>'
            f'<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem">'
            f'{"".join(review_cards)}'
            f'</div></div></section>'
        )

    # ── Bookstagram / customer reels strip (loaded from data/social_proof.json) ──
    bkg_html = ""
    if social_items:
        cards = []
        for it in social_items[:6]:
            src = it.get("src") or ""
            poster = it.get("poster") or ""
            cap = html_escape(it.get("caption") or "")
            if it.get("type") == "video" and src:
                cards.append(
                    f'<div style="flex:0 0 200px;aspect-ratio:9/16;background:#1a1208;border:1px solid var(--border);'
                    f'position:relative;overflow:hidden;scroll-snap-align:start">'
                    f'<video src="{html_escape(src)}" {"poster=\"" + html_escape(poster) + "\"" if poster else ""} '
                    f'autoplay muted playsinline loop preload="auto" '
                    f'style="width:100%;height:100%;object-fit:cover;display:block"></video>'
                    f'{f"<div style=\"position:absolute;left:0;right:0;bottom:0;padding:.6rem;background:linear-gradient(to top,rgba(0,0,0,.85),transparent);font-size:.65rem;color:#f0e8d8;line-height:1.3\">{cap}</div>" if cap else ""}'
                    f'</div>'
                )
            elif src:
                cards.append(
                    f'<div style="flex:0 0 200px;aspect-ratio:9/16;background:#1a1208;border:1px solid var(--border);'
                    f'position:relative;overflow:hidden;scroll-snap-align:start">'
                    f'<img src="{html_escape(src)}" alt="{cap}" loading="lazy" '
                    f'style="width:100%;height:100%;object-fit:cover;display:block"/>'
                    f'{f"<div style=\"position:absolute;left:0;right:0;bottom:0;padding:.6rem;background:linear-gradient(to top,rgba(0,0,0,.85),transparent);font-size:.65rem;color:#f0e8d8;line-height:1.3\">{cap}</div>" if cap else ""}'
                    f'</div>'
                )
        bkg_html = (
            f'<section style="max-width:1260px;margin:2rem auto 0;padding:0 1rem">'
            f'<div style="border-top:1px solid var(--border);padding-top:1.6rem">'
            f'<h2 style="font-family:\'Cormorant Garamond\',serif;font-size:1.4rem;font-weight:500;color:var(--cream);margin:0 0 1rem">'
            f'#InkAndChaiBookstagram <span style="color:var(--muted);font-size:.7rem;letter-spacing:.18em;text-transform:uppercase;font-family:Montserrat,sans-serif">Real customer unboxings</span></h2>'
            f'<div style="display:flex;gap:.85rem;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:.5rem;-webkit-overflow-scrolling:touch">'
            f'{"".join(cards)}'
            f'</div></div></section>'
        )

    # ── You May Also Like section (pre-computed at build time) ──────────────
    related_books = related_books_for(book)
    author_label = html_escape(book.get("a") or "")
    if related_books and related_books[0].get("a", "").lower().strip() == (book.get("a") or "").lower().strip():
        also_heading = f'More by <em>{author_label}</em>'
    else:
        also_heading = 'You May Also <em>Like</em>'

    also_like_html = ""
    if related_books:
        cards_html = ""
        for r in related_books:
            r_title  = html_escape(r.get("t", ""))
            r_author = html_escape(r.get("a", ""))
            r_price  = html_escape(r.get("p", ""))
            r_img    = html_escape(r.get("img", ""))
            r_slug   = r.get("slug", "")
            img_tag  = f'<img src="{r_img}" alt="{r_title}" loading="lazy" style="width:100%;height:100%;object-fit:contain;display:block;background:#1a1208"/>' if r_img else ""
            cards_html += (
                f'<a href="/product/{r_slug}/" style="text-decoration:none;color:inherit;display:block">'
                f'<div style="aspect-ratio:2/3;background:#1a1208;border:1px solid rgba(201,168,76,.18);overflow:hidden;margin-bottom:.6rem;transition:border-color .2s">'
                f'{img_tag}</div>'
                f'<div style="font-family:\'Cormorant Garamond\',serif;font-size:.88rem;color:#f0e8d8;line-height:1.3;margin-bottom:.15rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">{r_title}</div>'
                f'<div style="font-size:.68rem;color:#a09080;letter-spacing:.04em;margin-bottom:.18rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{r_author}</div>'
                f'<div style="font-size:.82rem;color:#c9a84c;font-weight:600">{r_price}</div>'
                f'</a>'
            )
        also_like_html = (
            f'<section style="max-width:1260px;margin:0 auto;padding:2.5rem 1.5rem 4rem;border-top:1px solid rgba(201,168,76,.15)">'
            f'<h2 style="font-family:\'Cormorant Garamond\',serif;font-size:1.7rem;font-weight:400;color:#faf7f2;margin:0 0 1.6rem">'
            f'{also_heading}</h2>'
            f'<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:1.1rem" class="also-grid">'
            f'{cards_html}'
            f'</div>'
            f'</section>'
        )

    return f"""<!DOCTYPE html>
<html lang="{'hi' if is_hindi_book(book) else 'en'}">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>{title} | Buy Online in India | Ink &amp; Chai</title>
<meta name="description" content="{html_escape(book_description(book, 155))}"/>
<meta name="robots" content="index,follow"/>
<link rel="canonical" href="{canonical}"/>
<meta property="og:type" content="product"/>
<meta property="og:title" content="{title} | Ink &amp; Chai"/>
<meta property="og:description" content="{desc}"/>
<meta property="og:image" content="{img}"/>
<meta property="og:url" content="{canonical}"/>
<script type="application/ld+json">{product_json_ld(book)}</script>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=Montserrat:wght@300;400;600;700&display=swap" rel="stylesheet"/>
<script>(function(){{try{{var t=localStorage.getItem('iac_theme');if(t==='light')document.documentElement.setAttribute('data-theme','light')}}catch(e){{}}}})();</script>
<style>
:root{{--bg:#0d0b08;--panel:#1c1916;--gold:#c9a84c;--cream:#f0e8d8;--muted:#a09080;--border:rgba(201,168,76,.18);--white:#faf7f2}}
html[data-theme="light"]{{--bg:#faf7f2;--panel:#fff;--gold:#8a6a1f;--cream:#2a2018;--muted:#5a4a38;--border:rgba(138,106,31,.28);--white:#0d0b08}}
*{{box-sizing:border-box}} body{{margin:0;background:var(--bg);color:var(--cream);font-family:Montserrat,sans-serif;font-weight:400}} a{{color:inherit}}
.promo{{padding:.62rem 1rem;text-align:center;border-bottom:1px solid var(--border);font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}} .promo strong{{color:var(--gold)}}
nav{{display:flex;align-items:center;justify-content:space-between;padding:1rem clamp(1rem,4vw,4rem);border-bottom:1px solid var(--border);background:rgba(13,11,8,.97);position:sticky;top:0;z-index:5;backdrop-filter:blur(12px)}} html[data-theme="light"] nav{{background:rgba(250,247,242,.97)!important}} .logo{{font-family:"Cormorant Garamond",serif;font-size:1.5rem;color:var(--gold);text-decoration:none}} .back{{font-size:.62rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);text-decoration:none}}
.theme-btn{{background:transparent;border:1px solid var(--border);color:var(--gold);width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:.8rem;display:inline-flex;align-items:center;justify-content:center}}
.wrap{{max-width:1260px;margin:0 auto;padding:clamp(1.2rem,4vw,4rem) 1rem 4rem;display:grid;grid-template-columns:minmax(360px,.95fr) 1.05fr;gap:clamp(1.4rem,4vw,4rem);align-items:start}} .cover{{align-self:start;background:var(--panel);border:1px solid var(--border);padding:clamp(1rem,2.5vw,1.8rem);display:flex;align-items:center;justify-content:center;gap:.85rem;flex-wrap:wrap}} .cover img{{max-width:100%;max-height:560px;object-fit:contain;box-shadow:0 24px 64px rgba(0,0,0,.5)}} .cover-gallery img{{width:calc((100% - .85rem)/2);max-width:310px}} .cover-gallery img+img{{max-height:540px}}
.crumb{{font-size:.58rem;letter-spacing:.24em;text-transform:uppercase;color:var(--gold);margin-bottom:1rem}} h1{{font-family:"Cormorant Garamond",serif;font-size:clamp(2rem,5vw,3.4rem);font-weight:400;line-height:1.05;margin:.2rem 0 .6rem}} .author{{color:var(--muted);letter-spacing:.08em;margin-bottom:1rem}} .order-badge{{display:inline-flex;margin:0 0 1rem;border:1px solid rgba(138,106,31,.32);background:rgba(138,106,31,.08);color:var(--gold);font-size:.62rem;letter-spacing:.16em;text-transform:uppercase;padding:.42rem .75rem}} .rating-line{{display:flex;align-items:center;gap:.55rem;margin:0 0 1rem;color:var(--muted);font-size:.72rem}} .stars{{color:var(--gold);letter-spacing:.04em}} .price{{font-family:"Cormorant Garamond",serif;font-size:2.7rem;color:var(--gold);font-weight:600}} .orig{{color:var(--muted);text-decoration:line-through;margin-left:.8rem}} .stock{{display:inline-block;margin:1rem 0;color:#7fd37f;border:1px solid rgba(127,211,127,.3);padding:.35rem .65rem;font-size:.7rem;letter-spacing:.14em;text-transform:uppercase}}
.trust{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.7rem;margin:1.2rem 0}} .trust span{{border:1px solid var(--border);background:rgba(138,106,31,.06);padding:.75rem;color:var(--cream);font-size:.78rem}} .actions{{display:grid;grid-template-columns:1fr 1fr;gap:.8rem;margin:1.3rem 0}} button,.btn{{font:700 .68rem Montserrat,sans-serif;letter-spacing:.2em;text-transform:uppercase;padding:1rem;border:1px solid var(--gold);cursor:pointer;text-align:center;text-decoration:none}} .primary{{background:var(--gold);color:var(--bg)}} .secondary{{background:transparent;color:var(--gold)}} .is-loading{{position:relative;color:transparent!important;pointer-events:none;opacity:.78}} .is-loading::after{{content:'';position:absolute;left:50%;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spinBtn .75s linear infinite;color:#fff}} .secondary.is-loading::after{{color:var(--gold)}} @keyframes spinBtn{{to{{transform:rotate(360deg)}}}}
.desc,.details{{border-top:1px solid var(--border);padding-top:1.2rem;margin-top:1.2rem;color:var(--muted);font-size:.9rem;line-height:1.8}} .label{{font-size:.58rem;letter-spacing:.26em;text-transform:uppercase;color:var(--gold);margin-bottom:.5rem}} .details dl{{display:grid;grid-template-columns:120px 1fr;gap:.5rem 1rem}} .details dt{{color:var(--gold)}} .details dd{{margin:0;color:var(--cream)}}
.reviews{{border:1px solid var(--border);background:rgba(138,106,31,.055);padding:1.15rem;margin-top:1.3rem;color:var(--muted);line-height:1.7}} .review-head{{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start}} .review-head h2{{font-size:1.45rem;margin:.1rem 0 0}} .score{{text-align:right;flex-shrink:0}} .score strong{{display:block;font-family:"Cormorant Garamond",serif;font-size:2.2rem;color:var(--gold);line-height:.9}} .score span{{font-size:.62rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}} .review-media{{display:grid;grid-template-columns:1fr 1fr;gap:.8rem;margin-top:.9rem}} .review-media figure{{margin:0;border:1px solid var(--border);background:#fff;overflow:hidden}} .review-media img,.review-media video{{display:block;width:100%;height:240px;object-fit:cover;background:#f4efe7}} .review-media figcaption{{padding:.65rem .75rem;font-size:.65rem;letter-spacing:.08em;color:var(--muted)}}
@media(max-width:760px){{.wrap{{display:block;padding-bottom:8rem}} .cover{{margin-bottom:1.2rem}} .actions{{position:fixed;left:0;right:0;bottom:0;z-index:9;background:rgba(13,11,8,.98);padding:.75rem 1rem calc(.75rem + env(safe-area-inset-bottom));border-top:1px solid var(--border);box-shadow:0 -10px 26px rgba(60,40,10,.12)}} .trust{{grid-template-columns:1fr}} .review-head{{display:block}} .score{{text-align:left;margin-top:.7rem}} .review-media{{grid-template-columns:1fr}} .review-media img,.review-media video{{height:auto;max-height:360px;object-fit:contain}}}}
@media(max-width:1100px){{.also-grid{{grid-template-columns:repeat(4,1fr)!important}}}}
@media(max-width:640px){{.also-grid{{grid-template-columns:repeat(2,1fr)!important;gap:.7rem!important}}}}
html[data-theme="light"] .actions{{background:rgba(250,247,242,.98)}}
</style>
</head>
<body>
<div class="promo"><strong>Free delivery on ₹499+</strong> · Prepaid offers up to <strong>15% off</strong> · COD available</div>
<nav><a class="logo" href="/">Ink &amp; Chai</a><div style="display:flex;align-items:center;gap:1rem"><a class="back" href="/">← Catalogue</a><button class="theme-btn" onclick="(function(){{var d=document.documentElement;var t=d.getAttribute('data-theme');var n=t==='light'?null:'light';if(n)d.setAttribute('data-theme',n);else d.removeAttribute('data-theme');try{{localStorage.setItem('iac_theme',n||'dark')}}catch(e){{}}}})()" title="Toggle theme">☀</button></div></nav>
<main class="wrap">
  <div>
    <section class="{static_cover_class}"><img src="{img}" alt="{title} book cover" loading="eager" fetchpriority="high" onclick="openLB(this.src,this.alt)" style="cursor:zoom-in"/>{static_back_cover}</section>
    {sample_pdf_html}
  </div>
  <section>
    <div class="crumb"><a href="/">Home</a> / <a href="/category/?name={quote(book.get('cat') or 'Books')}">{cat}</a></div>
    <h1>{title}</h1>
    <div class="author">by {author}</div>
{order_badge_html}
{rating_line_html}
    <div><span class="price" data-product-price>{price}</span>{f'<span class="orig" data-product-original-price>{orig}</span>' if orig else ''}</div>
    <span class="stock">In Stock</span>
    <div class="trust"><span>🚚 Delivery in 2-5 days</span><span>💵 Cash on delivery available</span><span>💳 UPI, cards, net banking</span><span>🛡 7-day replacement support</span></div>
    <div class="actions">
      <button class="secondary" onclick="addBookToCart(this)">Add to Cart</button>
      <button class="primary" onclick="buyNowBook(this)">Buy Now</button>
    </div>
    <div class="desc"><div class="label">About this book</div>{desc}</div>
{review_html}
    <div class="details"><div class="label">Details</div><dl><dt>Category</dt><dd>{cat}</dd><dt>Publisher</dt><dd>{html_escape(book.get('pub') or 'Ink & Chai')}</dd><dt>ISBN</dt><dd>{html_escape(book.get('isbn') or 'Available on request')}</dd><dt>Sold by</dt><dd>Ink &amp; Chai</dd></dl></div>
  </section>
</main>
{reviews_html}
{also_like_html}
{bkg_html}

<!-- Image lightbox -->
<div id="lb" onclick="closeLB()" style="position:fixed;inset:0;background:rgba(0,0,0,.94);z-index:10500;display:none;align-items:center;justify-content:center;padding:1.5rem;cursor:zoom-out;backdrop-filter:blur(8px)" role="dialog" aria-label="Cover preview">
  <button onclick="event.stopPropagation();closeLB()" aria-label="Close" style="position:absolute;top:1rem;right:1rem;width:38px;height:38px;border-radius:50%;background:rgba(13,11,8,.85);color:#c9a84c;border:1px solid rgba(201,168,76,.4);cursor:pointer;font-size:1.2rem;display:flex;align-items:center;justify-content:center">✕</button>
  <img id="lbI" src="" alt="" onclick="event.stopPropagation()" style="max-width:96vw;max-height:92vh;object-fit:contain;box-shadow:0 30px 80px rgba(0,0,0,.6);background:#1a1208;cursor:zoom-out"/>
</div>

<!-- Sample PDF modal — renders pages as canvas via PDF.js (no iframe, no X-Frame issues) -->
<div id="pdfM" style="position:fixed;inset:0;background:rgba(0,0,0,.94);z-index:10600;display:none;align-items:center;justify-content:center;padding:1rem;backdrop-filter:blur(8px)" role="dialog" aria-label="Sample preview">
  <div onclick="event.stopPropagation()" style="position:relative;width:100%;max-width:780px;height:92vh;background:#1a1410;border:1px solid rgba(138,106,31,.35);display:flex;flex-direction:column">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:.85rem 1.1rem;border-bottom:1px solid rgba(138,106,31,.28);background:#0f0c08;gap:.7rem">
      <div id="pdfT" style="font-family:'Cormorant Garamond',serif;font-size:1rem;color:#f0e8d8;font-weight:500;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Sample Pages</div>
      <a id="pdfDl" href="#" download target="_blank" rel="noopener" style="font:600 .55rem Montserrat,sans-serif;letter-spacing:.18em;text-transform:uppercase;padding:.5rem .85rem;background:transparent;color:#c9a84c;border:1px solid rgba(201,168,76,.4);text-decoration:none;cursor:pointer">⬇ Download</a>
      <button onclick="closePdf()" style="font:600 .55rem Montserrat,sans-serif;letter-spacing:.18em;text-transform:uppercase;padding:.5rem .85rem;background:rgba(201,168,76,.12);color:#c9a84c;border:1px solid #c9a84c;cursor:pointer">✕ Close</button>
    </div>
    <div id="pdfPages" style="flex:1;overflow-y:auto;padding:1.2rem;display:flex;flex-direction:column;align-items:center;gap:1rem;background:#1a1410">
      <div id="pdfLoading" style="color:#a09080;font-size:.85rem;padding:3rem 1rem;text-align:center">Loading sample pages...</div>
    </div>
  </div>
</div>

<script src="/js/cart.js"></script>
<script src="/js/summer-sale.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js" defer></script>
<script>
let currentItem = {cart_item};
function priceText(value) {{
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? '₹ ' + n.toLocaleString('en-IN', {{ maximumFractionDigits: 0 }}) : '';
}}
async function applyRuntimeProductOverride() {{
  try {{
    const slug = location.pathname.split('/').filter(Boolean)[1] || '';
    const res = await fetch('/.netlify/functions/get-product-overrides', {{ cache: 'no-store' }});
    if (!res.ok) return;
    const data = await res.json();
    const key = String(slug || '').toLowerCase();
    const override = (data.overrides || []).find(o => String(o.slug || '').toLowerCase() === key);
    if (!override) return;
    if (override.title) {{
      currentItem.title = override.title;
      const h1 = document.querySelector('h1');
      if (h1) h1.textContent = override.title;
      document.querySelectorAll('.crumb').forEach(el => {{
        const parts = el.innerHTML.split('&nbsp;/&nbsp;');
        if (parts.length) parts[parts.length - 1] = override.title;
        el.innerHTML = parts.join('&nbsp;/&nbsp;');
      }});
    }}
    if (override.author) {{
      currentItem.author = override.author;
      const author = document.querySelector('.author');
      if (author) author.textContent = 'by ' + override.author;
    }}
    if (override.price_inr !== null && override.price_inr !== undefined) {{
      currentItem.price = Number(override.price_inr) || currentItem.price;
      const saleText = priceText(override.price_inr);
      document.querySelectorAll('[data-product-price], .price, .prod-price').forEach(el => {{
        el.textContent = saleText;
        el.setAttribute('data-live-override', 'price');
      }});
    }}
    if (override.original_price_inr !== null && override.original_price_inr !== undefined) {{
      const mrpText = priceText(override.original_price_inr);
      document.querySelectorAll('[data-product-original-price], .orig, .prod-orig').forEach(el => {{
        el.textContent = mrpText;
        el.setAttribute('data-live-override', 'original-price');
      }});
    }}
  }} catch (err) {{
    console.warn('Product override unavailable:', err.message);
  }}
}}
function setBtnLoading(btn,on) {{
  if (!btn) return;
  btn.classList.toggle('is-loading', !!on);
  btn.disabled = !!on;
}}
function addBookToCart(btn) {{
  if (window.stopReaderActivity) stopReaderActivity();
  setBtnLoading(btn, true);
  localStorage.removeItem('iac_buy_now_cart');
  const item = {{ ...currentItem }};
  const cart = JSON.parse(localStorage.getItem('akshar_cart') || '[]');
  const existing = cart.find(x => x.id === item.id);
  if (existing) existing.qty = (existing.qty || 1) + 1; else cart.push(item);
  localStorage.setItem('akshar_cart', JSON.stringify(cart));
  if (window.refreshCart) refreshCart();
  setTimeout(() => {{
    setBtnLoading(btn, false);
    if (window.openCart) openCart();
    if (window.showToast) showToast('Added to cart');
  }}, 180);
}}
function buyNowBook(btn) {{
  if (window.stopReaderActivity) stopReaderActivity();
  setBtnLoading(btn, true);
  const item = {{ ...currentItem }};
  localStorage.setItem('iac_buy_now_cart', JSON.stringify([item]));
  setTimeout(() => {{ location.href='/checkout/'; }}, 220);
}}
function openLB(src, alt) {{
  document.getElementById('lbI').src = src;
  document.getElementById('lbI').alt = alt || '';
  document.getElementById('lb').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}}
function closeLB() {{
  document.getElementById('lb').style.display = 'none';
  document.body.style.overflow = '';
}}
async function openPdf(url, title) {{
  document.getElementById('pdfDl').href = url;
  document.getElementById('pdfT').textContent = (title || 'Sample Pages') + ' — Free Sample';
  document.getElementById('pdfM').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  if (window.fbq) fbq('trackCustom', 'ReadSample', {{ content_name: title || '', content_type: 'product_sample' }});

  const pagesDiv = document.getElementById('pdfPages');
  pagesDiv.innerHTML = '<div style="color:#a09080;font-size:.85rem;padding:3rem 1rem;text-align:center">Loading sample pages...</div>';

  // Wait for pdf.js to be ready (it's loaded with `defer`)
  let tries = 0;
  while (typeof pdfjsLib === 'undefined' && tries < 60) {{
    await new Promise(r => setTimeout(r, 100));
    tries++;
  }}
  if (typeof pdfjsLib === 'undefined') {{
    pagesDiv.innerHTML = '<div style="color:#e05050;padding:2rem;text-align:center">Could not load PDF viewer. <a href="' + url + '" download style="color:#c9a84c">Download instead</a></div>';
    return;
  }}
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  try {{
    const pdf = await pdfjsLib.getDocument(url).promise;
    pagesDiv.innerHTML = '';
    const containerWidth = pagesDiv.clientWidth - 40;  // padding allowance
    for (let i = 1; i <= pdf.numPages; i++) {{
      const page = await pdf.getPage(i);
      const baseViewport = page.getViewport({{ scale: 1 }});
      const scale = Math.min(2.5, containerWidth / baseViewport.width);
      const viewport = page.getViewport({{ scale }});
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width  = Math.floor(viewport.width  * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width  = Math.floor(viewport.width)  + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';
      canvas.style.maxWidth = '100%';
      canvas.style.boxShadow = '0 12px 32px rgba(0,0,0,.5)';
      canvas.style.background = '#fff';
      ctx.scale(dpr, dpr);
      pagesDiv.appendChild(canvas);
      await page.render({{ canvasContext: ctx, viewport: viewport }}).promise;
    }}
    const note = document.createElement('div');
    note.style.cssText = 'color:#a09080;font-size:.7rem;letter-spacing:.18em;text-transform:uppercase;padding:1rem;text-align:center;border-top:1px solid rgba(201,168,76,.18);margin-top:.5rem;width:100%';
    note.innerHTML = 'End of sample · <a href="javascript:closePdf()" style="color:#c9a84c">Buy the full book →</a>';
    pagesDiv.appendChild(note);
  }} catch (err) {{
    pagesDiv.innerHTML = '<div style="color:#e05050;padding:2rem;text-align:center">Could not render the PDF. <a href="' + url + '" download style="color:#c9a84c">Download instead</a></div>';
  }}
}}
function closePdf() {{
  document.getElementById('pdfM').style.display = 'none';
  document.getElementById('pdfPages').innerHTML = '';
  document.body.style.overflow = '';
}}
document.addEventListener('keydown', e => {{
  if (e.key !== 'Escape') return;
  if (document.getElementById('lb').style.display === 'flex') closeLB();
  if (document.getElementById('pdfM').style.display === 'flex') closePdf();
}});
applyRuntimeProductOverride();
</script>
</body>
</html>"""

product_root = Path(__file__).parent / "public" / "product"
for old_product_dir in product_root.iterdir():
    if old_product_dir.is_dir():
        shutil.rmtree(old_product_dir)
for book in slim:
    out = product_root / book["slug"] / "index.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(with_meta_pixel(with_reader_activity(static_product_html(book))), encoding="utf-8")
print(f"Generated crawlable product pages: {len(slim)}")

SELF_HELP_TERMS = ["self", "help", "habit", "hurt", "finished", "rich dad", "psychology", "money", "power", "think", "mindset", "discipline", "atomic", "goggins", "ikigai", "motivation"]
COMBO_TERMS = ["combo", "boxset", "box set", "collection", "set of", "special 99 box"]
PY_TRENDING_PATTERNS = [
    ("onyx storm", 120), ("sunrise on the reaping", 118), ("the let them theory", 116),
    ("great big beautiful life", 114), ("the tenant", 112), ("the housemaid", 110),
    ("king of gluttony", 108), ("twisted love", 106), ("it ends with us", 104),
    ("atomic habits", 102), ("the psychology of money", 100), ("rich dad poor dad", 98),
    ("don't believe everything you think", 96), ("dont believe everything you think", 96),
    ("can't hurt me", 94), ("cant hurt me", 94), ("never finished", 92),
    ("the hidden hindu", 90), ("the subtle art of not giving", 88),
    ("48 laws of power", 86), ("ikigai", 84), ("the alchemist", 82),
]

def py_trend_score(book):
    hay = f"{book.get('t','')} {book.get('url','')}".lower().replace("’", "'").replace("*", "")
    for pattern, score in PY_TRENDING_PATTERNS:
        if pattern in hay:
            return score
    return 40 if ("trending" in hay or "bestseller" in hay) else 0

def py_edition_penalty(book):
    title = str(book.get("t", "")).lower()
    penalty = 0
    if "combo" in title or "set of" in title:
        penalty += 6
    if "preloved" in title:
        penalty += 5
    if "workbook" in title:
        penalty += 4
    if "movie edition" in title:
        penalty += 2
    return penalty

LANDING_PAGES = [
    ("hindi-books", "Hindi Books Online", "Shop Hindi editions of bestselling self-help, money, psychology, business, and motivational books.", lambda b: is_hindi_book(b)),
    ("self-help-books", "Self-Help Books Online", "Discover practical books on habits, mindset, discipline, money, productivity, psychology, and personal growth.", lambda b: any(k in f"{b.get('t','')} {b.get('cat','')} {b.get('desc','')}".lower() for k in SELF_HELP_TERMS)),
    ("bestsellers", "Bestselling Books Online", "Explore the most popular and trending books at Ink & Chai, including Hindi self-help, romance, fiction, and BookTok favourites.", lambda b: py_trend_score(b) > 0 or "bestseller" in f"{b.get('t','')} {b.get('desc','')} {b.get('cat','')}".lower()),
    ("new-arrivals", "New Arrival Books", "Freshly added books and latest arrivals across Hindi editions, self-help, fiction, romance, manga, and more.", lambda b: b.get("n") == 1),
    ("book-combos", "Book Combos Online", "Value book combos and boxsets for self-help, fiction, romance, manga, and readers who want more books for less.", lambda b: any(k in f"{b.get('t','')} {b.get('cat','')}".lower() for k in COMBO_TERMS)),
    # Legacy SEO URLs kept alive so old indexed links continue to work.
    ("hindi-self-help-books", "Hindi Self Help Books Online", "Motivational, psychology, money, and discipline books translated for Indian readers.", lambda b: is_hindi_book(b) and any(k in f"{b.get('t','')} {b.get('cat','')} {b.get('desc','')}".lower() for k in SELF_HELP_TERMS)),
    ("business-books-hindi", "Best Business Books in Hindi", "Business, money, startup, and investing books in Hindi editions.", lambda b: is_hindi_book(b) and any(k in b.get("t","").lower() for k in ["rich dad", "hard thing", "business", "money", "finance", "invest", "psychology", "atomic habits"])),
    ("manga-books-india", "Manga Books Online in India", "Popular manga, comics, and graphic novels delivered across India.", lambda b: any(k in f"{b.get('t','')} {b.get('cat','')}".lower() for k in ["manga", "comic", "naruto", "death note", "demon slayer", "one piece", "jujutsu"])),
    ("cod-books-online", "COD Books Online India", "Bestselling books you can order with cash on delivery, UPI, cards, and pan-India shipping.", lambda b: price_number(b) > 0),
]

def landing_rank(book):
    return (
        -py_trend_score(book),
        -int(bool(book.get("n"))),
        py_edition_penalty(book),
        -price_number(book),
        book.get("t", ""),
    )

def landing_html(slug, heading, intro, selected):
    def clean(value):
        return re.sub(r"\s+", " ", str(value or "")).strip()
    cards = "\n".join(f"""
      <a class="card" href="{product_path(b['slug'])}">
        <span class="cover"><img src="{html_escape(absolute_img(b))}" alt="{html_escape(clean(b.get('t')))} cover" loading="lazy"/></span>
        <strong>{html_escape(clean(b.get('t')))}</strong>
        <small>{html_escape(clean(b.get('a') or b.get('cat') or 'Ink & Chai'))}</small>
        <span class="price">{html_escape(clean(b.get('p')))}</span>
      </a>""" for b in selected[:36])
    return f"""<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>{html_escape(heading)} | Ink &amp; Chai</title><meta name="description" content="{html_escape(intro)} Buy online at Ink & Chai with COD, UPI, cards, and free delivery on ₹499+ orders."/>
<link rel="canonical" href="{SITE}/{slug}/"/><meta name="robots" content="index,follow"/>
<style>:root{{--bg:#0d0b08;--gold:#c9a84c;--cream:#f0e8d8;--muted:#a09080;--border:rgba(201,168,76,.2)}}*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--cream);font-family:Montserrat,Arial,sans-serif}}nav{{padding:1rem clamp(1rem,4vw,4rem);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:1rem;align-items:center}}a{{color:inherit;text-decoration:none}}.logo{{font-family:serif;font-size:1.5rem;color:var(--gold)}}.links{{display:flex;gap:1rem;flex-wrap:wrap;color:var(--muted);font-size:.7rem;letter-spacing:.12em;text-transform:uppercase}}main{{max-width:1180px;margin:auto;padding:clamp(2rem,6vw,5rem) 1rem}}.eyebrow{{color:var(--gold);letter-spacing:.24em;text-transform:uppercase;font-size:.65rem}}h1{{font-family:serif;font-size:clamp(2.5rem,7vw,5rem);font-weight:400;line-height:1;margin:.8rem 0}}p{{color:var(--muted);max-width:760px;line-height:1.8}}.grid{{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:1.4rem;margin-top:2.5rem}}.card{{min-width:0}}.cover{{display:flex;aspect-ratio:2/3;background:#17130f;border:1px solid var(--border);align-items:center;justify-content:center;margin-bottom:.8rem}}img{{max-width:100%;max-height:100%;object-fit:contain}}strong{{display:block;font-family:serif;font-size:1.05rem;line-height:1.25}}small{{display:block;color:var(--muted);margin:.25rem 0 .4rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}.price{{color:var(--gold);font-weight:700}}.trust{{display:flex;gap:1rem;flex-wrap:wrap;margin-top:1.4rem;color:var(--gold);font-size:.8rem}}.cta{{margin-top:1.6rem;display:inline-block;border:1px solid var(--gold);padding:.8rem 1.2rem;color:var(--gold);font-size:.7rem;letter-spacing:.16em;text-transform:uppercase}}@media(max-width:900px){{.grid{{grid-template-columns:repeat(3,minmax(0,1fr))}}}}@media(max-width:560px){{nav{{align-items:flex-start;flex-direction:column}}.links{{font-size:.62rem}}.grid{{grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}}}}</style></head>
<body><nav><a class="logo" href="/">Ink &amp; Chai</a><div class="links"><a href="/hindi-books/">Hindi</a><a href="/self-help-books/">Self-help</a><a href="/bestsellers/">Bestsellers</a><a href="/new-arrivals/">New</a><a href="/book-combos/">Combos</a></div></nav><main><div class="eyebrow">Curated collection</div><h1>{html_escape(heading)}</h1><p>{html_escape(intro)}</p><div class="trust"><span>Free delivery on ₹499+</span><span>COD available</span><span>UPI/cards accepted</span><span>7-day replacement support</span></div><a class="cta" href="/">Search full catalogue</a><section class="grid">{cards}</section></main></body></html>"""

for slug, heading, intro, predicate in LANDING_PAGES:
    selected = sorted([b for b in slim if predicate(b)], key=landing_rank)
    if slug == "cod-books-online":
        selected = sorted(selected, key=lambda b: (not is_hindi_book(b), -price_number(b)))[:36]
    out = Path(__file__).parent / "public" / slug / "index.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(with_meta_pixel(landing_html(slug, heading, intro, selected)), encoding="utf-8")
print(f"Generated SEO landing pages: {len(LANDING_PAGES)}")

# ── Checkout Page ─────────────────────────────────────────────────────────────
CHECKOUT_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"/>
<meta http-equiv="Pragma" content="no-cache"/>
<meta http-equiv="Expires" content="0"/>
<title>Checkout — Ink &amp; Chai</title>
<link rel="icon" type="image/png" sizes="32x32" href="/images/favicon-32.png"/>
<link rel="icon" type="image/png" sizes="96x96" href="/images/favicon-96.png"/>
<link rel="apple-touch-icon" href="/images/apple-touch-icon.png"/>
<link rel="manifest" href="/manifest.json"/>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400;1,600&family=Montserrat:wght@300;400;500;600&display=swap" rel="stylesheet"/>
<script>(function(){try{var t=localStorage.getItem('iac_theme');if(t==='light')document.documentElement.setAttribute('data-theme','light')}catch(e){}})()</script>
<style>
:root{--bg:#0d0b08;--bg2:#141210;--bg3:#1c1916;--gold:#c9a84c;--gold-dim:#7a6330;--cream:#f0e8d8;--cream-dim:#a09080;--white:#faf7f2;--border:rgba(201,168,76,0.18)}
html[data-theme="light"]{--bg:#faf7f2;--bg2:#f3ece0;--bg3:#ffffff;--gold:#8a6a1f;--gold-dim:#6a4f10;--cream:#2a2018;--cream-dim:#5a4a38;--white:#0d0b08;--border:rgba(138,106,31,0.28)}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{max-width:100%;overflow-x:hidden;}
body{background:var(--bg);color:var(--cream);font-family:'Montserrat',sans-serif;font-weight:400;min-height:100vh}
nav{display:flex;align-items:center;justify-content:space-between;padding:1.2rem 3rem;background:rgba(13,11,8,0.97);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100;backdrop-filter:blur(12px);}
html[data-theme="light"] nav{background:rgba(250,247,242,0.97)!important}
.logo{font-family:'Cormorant Garamond',serif;font-size:1.5rem;font-weight:600;color:var(--gold);text-decoration:none;}
.logo span{color:var(--cream);font-weight:400;font-style:italic}
.theme-toggle{background:transparent;border:1px solid var(--border);color:var(--gold);width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:0.8rem;display:inline-flex;align-items:center;justify-content:center;transition:all 0.2s;}
.theme-toggle:hover{background:var(--gold);color:var(--bg)}
.nav-back{font-size:0.62rem;letter-spacing:0.2em;text-transform:uppercase;color:var(--cream-dim);text-decoration:none;transition:color 0.2s;}
.nav-back:hover{color:var(--gold)}
main{max-width:900px;margin:0 auto;padding:3.5rem 1.5rem 6rem;}
.page-label{font-size:0.55rem;letter-spacing:0.35em;text-transform:uppercase;color:var(--gold);margin-bottom:0.6rem;}
h1{font-family:'Cormorant Garamond',serif;font-size:2.4rem;font-weight:400;color:var(--white);margin-bottom:2.5rem;}
.checkout-grid{display:grid;grid-template-columns:1.15fr 1fr;gap:2.5rem;align-items:start;}
@media(max-width:700px){.checkout-grid{grid-template-columns:1fr;gap:1.5rem;}.order-summary{order:-1;}}
/* Order Summary */
.order-summary{background:var(--bg3);border:1px solid var(--border);padding:1.8rem;position:sticky;top:80px;}
.summary-title{font-size:0.58rem;letter-spacing:0.28em;text-transform:uppercase;color:var(--gold);margin-bottom:1.4rem;}
.order-item{display:flex;gap:1rem;padding:0.9rem 0;border-bottom:1px solid rgba(201,168,76,0.1);min-width:0;}
.order-item:last-child{border-bottom:none;}
.item-img{width:52px;flex-shrink:0;aspect-ratio:2/3;background:var(--bg2);overflow:hidden;border:1px solid var(--border);}
.item-img img{width:100%;height:100%;object-fit:cover;}
.item-info{flex:1;min-width:0;}
.item-title{font-family:'Cormorant Garamond',serif;font-size:1rem;color:var(--white);line-height:1.3;margin-bottom:0.2rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.item-author{font-size:0.6rem;color:var(--cream-dim);letter-spacing:0.06em;margin-bottom:0.3rem;}
.item-qty-price{font-size:0.68rem;color:var(--cream-dim);}
.item-price-gold{color:var(--gold);font-family:'Cormorant Garamond',serif;font-size:1rem;}
.checkout-qty-row{display:flex;align-items:center;gap:0.55rem;margin-top:0.55rem;flex-wrap:wrap;}
.checkout-qty-btn{width:28px;height:28px;border:1px solid var(--border);background:var(--bg2);color:var(--cream);font-size:1rem;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;}
.checkout-qty-btn:hover{border-color:var(--gold);color:var(--gold);}
.checkout-qty-num{min-width:24px;text-align:center;color:var(--cream);font-size:0.78rem;font-weight:500;}
.checkout-remove{border:none;background:transparent;color:#c97a7a;font-size:0.55rem;letter-spacing:0.14em;text-transform:uppercase;cursor:pointer;margin-left:0.2rem;}
.checkout-remove:hover{color:#e06060;}
.coupon-box{border-top:1px solid var(--border);margin-top:1rem;padding-top:1rem;}
.coupon-row{display:grid;grid-template-columns:1fr auto;gap:0.55rem;align-items:stretch;}
.coupon-select{width:100%;margin-bottom:0.55rem;background:var(--bg3);border:1px solid var(--border);color:var(--cream);padding:0.8rem 1rem;font-family:'Montserrat',sans-serif;font-size:0.72rem;letter-spacing:0.08em;outline:none;}
.coupon-input{font-size:0.72rem;text-transform:uppercase;letter-spacing:0.12em;}
.coupon-btn{font-family:'Montserrat',sans-serif;font-size:0.55rem;letter-spacing:0.16em;text-transform:uppercase;padding:0.75rem 0.9rem;background:var(--bg2);color:var(--gold);border:1px solid var(--border);cursor:pointer;font-weight:500;}
.coupon-btn:hover{border-color:var(--gold);background:rgba(138,106,31,0.08);}
.coupon-msg{min-height:1.2em;margin-top:0.45rem;font-size:0.58rem;letter-spacing:0.05em;color:var(--cream-dim);line-height:1.5;}
.summary-line{display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0;font-size:0.78rem;gap:1rem;}
.summary-line-label{color:var(--cream-dim);letter-spacing:0.04em;}
.summary-line-value{color:var(--cream);text-align:right;white-space:nowrap;}
.summary-line-discount .summary-line-value{color:#5d9b55;}
.summary-total{display:flex;justify-content:space-between;align-items:baseline;padding-top:1.2rem;margin-top:0.4rem;border-top:1px solid var(--border);}
.total-label{font-size:0.58rem;letter-spacing:0.2em;text-transform:uppercase;color:var(--cream-dim);}
.total-amt{font-family:'Cormorant Garamond',serif;font-size:1.8rem;color:var(--gold);font-weight:600;}
.empty-cart{text-align:center;padding:2.5rem 1rem;color:var(--cream-dim);}
/* Form */
.form-section{display:flex;flex-direction:column;gap:0;}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem;}
.form-group{margin-bottom:1rem;}
label{display:block;font-size:0.56rem;letter-spacing:0.2em;text-transform:uppercase;color:var(--cream-dim);margin-bottom:0.45rem;}
input,textarea,select{width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--cream);padding:0.8rem 1rem;font-family:'Montserrat',sans-serif;font-size:0.8rem;outline:none;transition:border-color 0.2s;}
input,textarea{-webkit-appearance:none;}
input:focus,textarea:focus,select:focus{border-color:rgba(201,168,76,0.5);}
input::placeholder,textarea::placeholder{color:rgba(160,144,128,0.5);}
input:disabled{background:var(--bg2);color:var(--gold-dim);cursor:not-allowed;}
.pincode-row{display:grid;grid-template-columns:110px 1fr 1fr;gap:1rem;margin-bottom:0.3rem;}
@media(max-width:700px){
  /* iOS auto-zooms any input with text smaller than 16px — bumping up
     prevents the form from looking comically huge after focus. */
  input,textarea,select{font-size:16px!important;padding:0.7rem 0.9rem;}
  label{font-size:0.62rem;margin-bottom:0.35rem;}
}
.pin-msg{font-size:0.6rem;min-height:1.1em;margin-bottom:0.8rem;letter-spacing:0.04em;}
.divider-label{display:flex;align-items:center;gap:1rem;margin:1.6rem 0 1.4rem;}
.divider-label span{font-size:0.54rem;letter-spacing:0.28em;text-transform:uppercase;color:var(--gold-dim);white-space:nowrap;}
.divider-label::before,.divider-label::after{content:'';flex:1;height:1px;background:var(--border);}
/* Payment method selector */
.pay-methods{display:flex;flex-direction:column;gap:0.6rem;margin-bottom:1rem;}
.pay-method{display:flex;align-items:center;gap:0.9rem;padding:0.8rem 1rem;background:var(--bg3);border:1.5px solid var(--border);cursor:pointer;transition:all 0.2s;}
.pay-method:hover{border-color:var(--gold-dim);}
.pay-method.active{border-color:var(--gold);background:rgba(201,168,76,0.06);}
.pay-method input[type="radio"]{accent-color:var(--gold);width:18px;height:18px;cursor:pointer;flex-shrink:0;}
.pay-method-icon{width:38px;height:38px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:1.2rem;border-radius:6px;font-family:'Montserrat',sans-serif;}
.pay-method-body{flex:1;min-width:0;}
.pay-method-title{font-family:'Montserrat',sans-serif;font-size:0.78rem;color:var(--cream);font-weight:500;letter-spacing:0.04em;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;}
.pay-method-badge{font-size:0.5rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--gold);background:rgba(201,168,76,0.12);padding:0.2rem 0.5rem;border:1px solid rgba(201,168,76,0.3);font-weight:500;}
.pay-method-sub{font-size:0.62rem;color:var(--cream-dim);margin-top:0.2rem;letter-spacing:0.04em;}
@media(max-width:780px){.pay-method-icon{width:32px;height:32px;font-size:1rem;}.pay-method{padding:0.7rem 0.8rem;gap:0.7rem;}}

.btn-pay{width:100%;font-family:'Montserrat',sans-serif;font-size:0.65rem;letter-spacing:0.25em;text-transform:uppercase;padding:1.1rem;background:var(--gold);color:var(--bg);border:none;cursor:pointer;font-weight:500;transition:all 0.25s;margin-bottom:0.8rem;line-height:1.4;white-space:normal;overflow-wrap:anywhere;}
.btn-pay:hover{opacity:0.88;transform:translateY(-1px);}
.btn-pay:disabled{opacity:0.72;cursor:not-allowed;transform:none;}
.btn-cod{width:100%;font-family:'Montserrat',sans-serif;font-size:0.65rem;letter-spacing:0.2em;text-transform:uppercase;padding:1rem;background:transparent;color:var(--cream);border:1px solid rgba(201,168,76,0.35);cursor:pointer;font-weight:400;transition:all 0.25s;line-height:1.4;white-space:normal;overflow-wrap:anywhere;}
.btn-cod:hover{border-color:var(--gold);color:var(--gold);}
.btn-cod:disabled{opacity:0.72;cursor:not-allowed;}
.btn-partial{width:100%;font-family:'Montserrat',sans-serif;font-size:0.62rem;letter-spacing:0.16em;text-transform:uppercase;padding:1rem;background:rgba(201,168,76,0.1);color:var(--gold);border:1px solid rgba(201,168,76,0.35);cursor:pointer;font-weight:500;transition:all 0.25s;margin-bottom:0.8rem;line-height:1.5;white-space:normal;overflow-wrap:anywhere;}
html[data-theme="light"] .btn-partial{background:#f7efe0;border-color:rgba(138,106,31,0.38);}
.btn-partial:hover{background:rgba(201,168,76,0.18);border-color:var(--gold);}
html[data-theme="light"] .btn-partial:hover{background:#f1e3c9;}
.btn-partial:disabled{opacity:0.72;cursor:not-allowed;}
.partial-note{font-size:0.58rem;color:var(--cream-dim);letter-spacing:0.04em;line-height:1.6;margin:-0.25rem 0 0.75rem;}
.btn-pay.is-loading,.btn-cod.is-loading,.btn-partial.is-loading{position:relative;color:transparent!important;pointer-events:none}
.btn-pay.is-loading::after,.btn-cod.is-loading::after,.btn-partial.is-loading::after{content:'';position:absolute;left:50%;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spinBtn .75s linear infinite;color:#fff}
.btn-cod.is-loading::after{color:var(--gold)}
.btn-partial.is-loading::after{color:var(--gold)}
@keyframes spinBtn{to{transform:rotate(360deg)}}
.trust-row{display:flex;gap:1.5rem;justify-content:center;margin-top:1.2rem;font-size:0.6rem;color:var(--gold-dim);letter-spacing:0.06em;flex-wrap:wrap;}
/* Success screen */
#successScreen{display:none;text-align:center;padding:4rem 2rem;max-width:560px;margin:0 auto;}
.success-icon{font-size:3.5rem;margin-bottom:1.5rem;}
.success-title{font-family:'Cormorant Garamond',serif;font-size:2.6rem;font-weight:400;color:var(--white);margin-bottom:1rem;}
.success-sub{font-size:0.78rem;color:var(--cream-dim);line-height:1.9;margin-bottom:1.6rem;}
.success-id{font-size:0.62rem;color:var(--gold-dim);letter-spacing:0.12em;margin-bottom:1.5rem;}
.success-email-box{background:var(--bg3);border:1px solid var(--border);border-left:3px solid var(--gold);padding:1rem 1.4rem;text-align:left;margin-bottom:2rem;}
.btn-home{font-family:'Montserrat',sans-serif;font-size:0.62rem;letter-spacing:0.22em;text-transform:uppercase;padding:0.9rem 2.4rem;background:var(--gold);color:var(--bg);border:none;cursor:pointer;font-weight:500;text-decoration:none;display:inline-block;}
footer{text-align:center;padding:2rem;border-top:1px solid var(--border);font-size:0.65rem;color:var(--gold-dim);letter-spacing:0.08em;margin-top:auto;}
@media(max-width:700px){
  nav{position:static;padding:1rem 1.2rem;}
  main{padding:2rem 1rem 5rem;}
  h1{font-size:1.7rem;margin-bottom:1.4rem;}
  .checkout-grid{grid-template-columns:1fr;gap:1.5rem;}
  .order-summary{order:-1;position:static!important;top:auto!important;padding:1.2rem;max-width:100%;overflow:hidden;}
  .item-title{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}
  .form-row{grid-template-columns:1fr;gap:0;}
  .pincode-row{grid-template-columns:110px 1fr;gap:0.7rem;}
  .pincode-row>div:nth-child(3){grid-column:1 / -1;}
  .coupon-row{grid-template-columns:1fr;}
  .coupon-btn{min-height:44px;}
  .btn-pay,.btn-cod,.btn-partial{letter-spacing:0.14em;padding:1rem 0.75rem;}
  .trust-row{display:grid;gap:0.55rem;font-size:0.58rem;}
  footer{padding:1.5rem 1rem;line-height:1.8;overflow-wrap:anywhere;}
}
@media(max-width:900px), (hover:none) and (pointer:coarse){
  nav{position:static!important;top:auto!important;}
  .order-summary{position:static!important;top:auto!important;inset:auto!important;transform:none!important;}
}
</style>
</head>
<body>
<nav>
  <a class="logo" href="/">Ink &amp;<span> Chai</span></a>
  <div style="display:flex;align-items:center;gap:1rem;">
    <a class="nav-back" href="javascript:history.back()">← Back</a>
    <button class="theme-toggle" onclick="(function(){var d=document.documentElement;var t=d.getAttribute('data-theme');if(t==='light'){d.removeAttribute('data-theme');try{localStorage.setItem('iac_theme','dark')}catch(e){}}else{d.setAttribute('data-theme','light');try{localStorage.setItem('iac_theme','light')}catch(e){}}})()" title="Toggle theme">☀</button>
  </div>
</nav>

<main>
  <!-- Success Screen (hidden until order placed) -->
  <div id="successScreen"></div>

  <!-- Checkout Screen -->
  <div id="checkoutScreen">
    <div class="page-label">Secure Checkout</div>
    <h1>Delivery Details</h1>

    <div class="checkout-grid">

      <!-- LEFT: Form -->
      <div class="form-section">
        <div class="form-row">
          <div class="form-group" style="margin:0;">
            <label for="ch-name">Full Name *</label>
            <input id="ch-name" type="text" placeholder="Your full name" autocomplete="name"/>
          </div>
          <div class="form-group" style="margin:0;">
            <label for="ch-phone">Phone Number *</label>
            <input id="ch-phone" type="tel" placeholder="10-digit mobile" autocomplete="tel"/>
          </div>
        </div>

        <div class="form-group">
          <label for="ch-email">Email Address</label>
          <input id="ch-email" type="email" placeholder="you@example.com" autocomplete="email"/>
        </div>

        <div class="form-group">
          <label for="ch-addr">House / Street / Locality *</label>
          <input id="ch-addr" type="text" placeholder="e.g. 12B, MG Road, Lajpat Nagar" autocomplete="street-address"/>
        </div>

        <div class="pincode-row">
          <div>
            <label for="ch-pin">Pincode *</label>
            <input id="ch-pin" type="text" inputmode="numeric" maxlength="6" placeholder="6 digits"
              oninput="handlePin(this.value)"/>
          </div>
          <div>
            <label for="ch-city">City</label>
            <input id="ch-city" type="text" placeholder="Auto-filled"/>
          </div>
          <div>
            <label for="ch-state">State</label>
            <input id="ch-state" type="text" placeholder="Auto-filled"/>
          </div>
        </div>
        <div id="pinMsg" class="pin-msg"></div>

        <div class="divider-label"><span>Choose Payment</span></div>

        <!-- Payment method selector — PhonePe default, Razorpay alt, COD always available -->
        <div class="pay-methods" role="radiogroup" aria-label="Payment method">
          <label class="pay-method active" data-method="phonepe">
            <input type="radio" name="payMethod" value="phonepe" checked/>
            <div class="pay-method-icon" style="background:#5f259f;color:#fff;font-weight:700;">P</div>
            <div class="pay-method-body">
              <div class="pay-method-title">PhonePe <span class="pay-method-badge">Recommended</span></div>
              <div class="pay-method-sub">UPI · Cards · Wallets · NetBanking</div>
            </div>
          </label>
          <label class="pay-method" data-method="razorpay">
            <input type="radio" name="payMethod" value="razorpay"/>
            <div class="pay-method-icon" style="background:#0c2451;color:#fff;font-weight:700;">R</div>
            <div class="pay-method-body">
              <div class="pay-method-title">Razorpay</div>
              <div class="pay-method-sub">UPI · Cards · NetBanking</div>
            </div>
          </label>
        </div>

        <button class="btn-pay" id="btnPayNow" onclick="submitOrder('online')">
          ⚡ Pay Now
        </button>
        <div style="display:flex;align-items:center;gap:0.45rem;margin-top:0.35rem;font-size:0.7rem;color:#6dbf6d;letter-spacing:0.04em;">
          <span style="font-size:0.9rem;">✅</span>
          <span><strong>100% refund guaranteed</strong> if you're not satisfied with the product</span>
        </div>
        <button class="btn-partial" id="btnPartial" onclick="submitOrder('partial')">
          Pay 10% Now · 90% on Delivery
        </button>
        <div class="partial-note" id="partialNote">Available on orders above ₹599.</div>
        <button class="btn-cod" id="btnCOD" onclick="submitOrder('cod')">
          🚚 Cash on Delivery
        </button>

        <div class="trust-row">
          <span>🔒 Secure checkout</span>
          <span>🚀 Pan-India delivery</span>
          <span>↩ 7-day returns</span>
        </div>
      </div>

      <!-- RIGHT: Order Summary -->
      <div class="order-summary">
        <div class="summary-title">Your Order</div>
        <div id="orderItems">
          <div class="empty-cart">Your cart is empty.<br/>
            <a href="/" style="color:var(--gold);">Browse books →</a>
          </div>
        </div>
        <div class="coupon-box" id="couponBox" style="display:none;">
          <label for="couponSelect">Available Coupons</label>
          <select class="coupon-select" id="couponSelect" onchange="handleCouponSelect(this.value)">
            <option value="">Choose a prepaid offer</option>
            <option value="INKLOVE10">INKLOVE10 · 10% off prepaid above ₹499</option>
            <option value="SAVE12">SAVE12 · 12% off prepaid above ₹999</option>
            <option value="SAVE15">SAVE15 · 15% off prepaid above ₹1499</option>
            <option value="499HIT">499HIT · 10% off prepaid above ₹499</option>
          </select>
          <label for="couponCode">Coupon Code</label>
          <div class="coupon-row">
            <input class="coupon-input" id="couponCode" type="text" placeholder="Or enter private code" autocomplete="off" onkeydown="handleCouponKey(event)"/>
            <button class="coupon-btn" type="button" onclick="applyCoupon()">Apply</button>
          </div>
          <div class="coupon-msg" id="couponMsg"></div>
        </div>
        <div class="summary-total" id="orderTotal" style="display:none;">
          <span class="total-label">Total</span>
          <span class="total-amt" id="totalAmt">₹0</span>
        </div>
      </div>

    </div>
  </div><!-- /checkoutScreen -->
</main>

<footer>© 2026 Ink &amp; Chai &nbsp;·&nbsp; inkandchai.in &nbsp;·&nbsp; support@inkandchai.in</footer>

<!-- Scripts -->
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
<script>
window.SUPABASE_URL      = "SUPABASE_URL_PLACEHOLDER";
window.SUPABASE_ANON_KEY = "SUPABASE_ANON_KEY_PLACEHOLDER";
</script>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>window.RAZORPAY_KEY_ID = "RAZORPAY_PUB_KEY_PLACEHOLDER";</script>

<script>
// ── Cart (must match cart.js CART_KEY) ────────────────────────────────────
const CART_KEY = 'akshar_cart';
const KW_CART_KEY = 'kw_cart';
const BUY_NOW_KEY = 'iac_buy_now_cart';
const IS_KAWAII = new URLSearchParams(location.search).get('kawaii') === '1';
function activeCartKey() {
  if (localStorage.getItem(BUY_NOW_KEY)) return BUY_NOW_KEY;
  if (IS_KAWAII) return KW_CART_KEY;
  return CART_KEY;
}
function getCart()  { try { return JSON.parse(localStorage.getItem(activeCartKey()) || '[]'); } catch { return []; } }
function clearCart(){ localStorage.removeItem(activeCartKey()); }
const ABANDONED_SESSION_KEY = 'iac_abandoned_checkout_session';
function checkoutSessionId() {
  let id = localStorage.getItem(ABANDONED_SESSION_KEY);
  if (!id) {
    id = 'iac_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(ABANDONED_SESSION_KEY, id);
  }
  return id;
}

// Shipping rules — must match cart.js + server functions
const FREE_SHIPPING_THRESHOLD = 499;
const SHIPPING_FEE = 40;
const COUPON_KEY = 'iac_checkout_coupon';
const COUPONS = {
  SUMMER10:  { type: 'percent', value: 10, minSubtotal: 299, onlineOnly: false, label: '☀️ Summer Sale 10% off', expiresAt: '2026-05-19T18:30:00Z' },
  INKLOVE10: { type: 'percent', value: 10, minSubtotal: 499, onlineOnly: true, label: '10% prepaid discount' },
  '499HIT':  { type: 'percent', value: 10, minSubtotal: 499, onlineOnly: true, label: '10% prepaid discount' },
  SAVE12:    { type: 'percent', value: 12, minSubtotal: 999, onlineOnly: true, label: '12% prepaid discount' },
  SAVE15:    { type: 'percent', value: 15, minSubtotal: 1499, onlineOnly: true, label: '15% prepaid discount' },
  CHAI10BACK:{ type: 'percent', value: 10, minSubtotal: 299, onlineOnly: true, label: 'Private 10% recovery discount' },
};
const PARTIAL_PAYMENT_THRESHOLD = 599;
const PARTIAL_PAYMENT_RATE = 0.10;
let appliedCouponCode = (localStorage.getItem(COUPON_KEY) || '').toUpperCase();
function calcShipping(subtotal) { return subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE; }
function itemQty(item) { return Math.max(1, Number(item?.qty) || 1); }
function itemPrice(item) { return Number(item?.price) || 0; }
function cartSubtotal(cart) { return cart.reduce((s, i) => s + itemPrice(i) * itemQty(i), 0); }
function saveCart(cart) { localStorage.setItem(activeCartKey(), JSON.stringify(cart)); }
function normalizeCouponCode(value) { return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function couponDiscount(subtotal, method = 'online') {
  const code = normalizeCouponCode(appliedCouponCode);
  const coupon = COUPONS[code];
  if (!coupon) return { code: '', discount: 0, message: '' };
  if (coupon.expiresAt && Date.now() > new Date(coupon.expiresAt).getTime()) {
    return { code, discount: 0, message: `${code} expired. Sale has ended.` };
  }
  if (subtotal < coupon.minSubtotal) {
    return { code, discount: 0, message: `Add ₹${(coupon.minSubtotal - subtotal).toLocaleString('en-IN')} more to use ${code}.` };
  }
  if (coupon.onlineOnly && method === 'cod') {
    return { code, discount: 0, message: `${code} is valid only on Pay Now orders.` };
  }
  const discount = coupon.type === 'percent' ? Math.floor(subtotal * coupon.value / 100) : Math.floor(coupon.value);
  return { code, discount: Math.max(0, discount), message: `${coupon.label} applied.` };
}
function orderTotals(cart, method = 'online') {
  const subtotal = cartSubtotal(cart);
  const shipping = calcShipping(subtotal);
  const coupon = couponDiscount(subtotal, method);
  const grand = Math.max(1, subtotal + shipping - coupon.discount);
  return { subtotal, shipping, discount: coupon.discount, couponCode: coupon.code, couponMessage: coupon.message, total: grand };
}
function partialPaymentTotals(cart) {
  const base = orderTotals(cart, 'cod');
  const eligible = base.total > PARTIAL_PAYMENT_THRESHOLD;
  const deposit = eligible ? Math.max(1, Math.ceil(base.total * PARTIAL_PAYMENT_RATE)) : 0;
  return { ...base, eligible, deposit, balance: Math.max(0, base.total - deposit), rate: PARTIAL_PAYMENT_RATE };
}
function cartWithPaymentMeta(cart, meta) {
  return cart.map((item, index) => index === 0 ? { ...item, _payment: meta } : item);
}
function updateCheckoutQty(index, delta) {
  const cart = getCart();
  if (!cart[index]) return;
  cart[index].qty = Math.max(1, itemQty(cart[index]) + delta);
  saveCart(cart);
  renderSummary();
  if (typeof scheduleAbandonedCapture === 'function') scheduleAbandonedCapture();
}
function removeCheckoutItem(index) {
  const cart = getCart();
  if (!cart[index]) return;
  cart.splice(index, 1);
  saveCart(cart);
  renderSummary();
  if (typeof scheduleAbandonedCapture === 'function') scheduleAbandonedCapture();
}

function handleCouponKey(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    applyCoupon();
  }
}

function handleCouponSelect(value) {
  const input = document.getElementById('couponCode');
  if (input) input.value = value || '';
  applyCoupon();
}

function applyCoupon() {
  const input = document.getElementById('couponCode');
  const select = document.getElementById('couponSelect');
  const msg = document.getElementById('couponMsg');
  const code = normalizeCouponCode(input?.value);
  if (!code) {
    appliedCouponCode = '';
    localStorage.removeItem(COUPON_KEY);
    if (select) select.value = '';
    if (msg) {
      msg.textContent = 'Coupon removed.';
      msg.style.color = 'var(--cream-dim)';
    }
    renderSummary();
    return;
  }
  if (!COUPONS[code]) {
    if (msg) {
      msg.textContent = 'This coupon code is not valid.';
      msg.style.color = '#c97a7a';
    }
    return;
  }
  appliedCouponCode = code;
  localStorage.setItem(COUPON_KEY, code);
  if (select) {
    const hasVisibleOption = Array.from(select.options).some(option => option.value === code);
    select.value = hasVisibleOption ? code : '';
  }
  renderSummary();
}

// ── Render order summary ────────────────────────────────────────────────────
function renderSummary() {
  const cart = getCart();
  const container = document.getElementById('orderItems');
  const totalRow  = document.getElementById('orderTotal');
  const totalEl   = document.getElementById('totalAmt');
  const btnPay    = document.getElementById('btnPayNow');
  const btnPartial = document.getElementById('btnPartial');
  const partialNote = document.getElementById('partialNote');
  const btnCOD    = document.getElementById('btnCOD');
  const couponBox = document.getElementById('couponBox');
  const couponInput = document.getElementById('couponCode');
  const couponSelect = document.getElementById('couponSelect');
  const couponMsg = document.getElementById('couponMsg');

  if (!cart.length) {
    container.innerHTML = IS_KAWAII
      ? '<div class="empty-cart">Your cart is empty.<br/><a href="/kawaii/" style="color:var(--gold);">Browse Kawaii Corner →</a></div>'
      : '<div class="empty-cart">Your cart is empty.<br/><a href="/" style="color:var(--gold);">Browse books →</a></div>';
    totalRow.style.display = 'none';
    if (couponBox) couponBox.style.display = 'none';
    if (btnPay) btnPay.disabled = true;
    if (btnPartial) btnPartial.disabled = true;
    if (partialNote) partialNote.textContent = 'Available on orders above ₹599.';
    if (btnCOD) btnCOD.disabled = true;
    return;
  }

  const { subtotal, shipping, discount, couponCode, couponMessage, total: grand } = orderTotals(cart, 'online');
  if (couponBox) couponBox.style.display = 'block';
  if (couponInput && couponInput.value !== appliedCouponCode) couponInput.value = appliedCouponCode;
  if (couponSelect) {
    const hasVisibleOption = Array.from(couponSelect.options).some(option => option.value === appliedCouponCode);
    couponSelect.value = hasVisibleOption ? appliedCouponCode : '';
  }
  if (couponMsg) {
    couponMsg.textContent = couponMessage || 'Choose a prepaid offer: 10% above ₹499, 12% above ₹999, or 15% above ₹1499.';
    couponMsg.style.color = couponCode && discount > 0 ? '#5d9b55' : (couponMessage ? '#c97a7a' : 'var(--cream-dim)');
  }
  container.innerHTML = cart.map((i, idx) => `
    <div class="order-item">
      <div class="item-img">
        ${i.img ? `<img src="${esc(i.img)}" alt="" />` : ''}
      </div>
      <div class="item-info">
        <div class="item-title">${esc(i.title)}</div>
        ${i.author ? `<div class="item-author">${esc(i.author)}</div>` : ''}
        <div class="item-qty-price">
          <span>₹${itemPrice(i).toLocaleString('en-IN')} each</span>
          &nbsp;·&nbsp;
          <span class="item-price-gold">₹${(itemPrice(i) * itemQty(i)).toLocaleString('en-IN')}</span>
        </div>
        <div class="checkout-qty-row">
          <button type="button" class="checkout-qty-btn" onclick="updateCheckoutQty(${idx}, -1)" aria-label="Decrease quantity">-</button>
          <span class="checkout-qty-num">Qty ${itemQty(i)}</span>
          <button type="button" class="checkout-qty-btn" onclick="updateCheckoutQty(${idx}, 1)" aria-label="Increase quantity">+</button>
          <button type="button" class="checkout-remove" onclick="removeCheckoutItem(${idx})">Remove</button>
        </div>
      </div>
    </div>`).join('') + `
    <div class="summary-line" style="border-top:1px solid var(--border);margin-top:0.5rem;padding-top:0.7rem;">
      <span class="summary-line-label">Subtotal</span>
      <span class="summary-line-value">₹${subtotal.toLocaleString('en-IN')}</span>
    </div>
    ${discount > 0 ? `<div class="summary-line summary-line-discount">
      <span class="summary-line-label">Coupon (${couponCode})</span>
      <span class="summary-line-value">- ₹${discount.toLocaleString('en-IN')}</span>
    </div>` : ''}
    <div class="summary-line" style="padding-bottom:0.7rem;">
      <span class="summary-line-label">Shipping (Delhivery)</span>
      <span class="summary-line-value" style="color:${shipping === 0 ? '#5d9b55' : 'var(--cream)'};">${shipping === 0 ? 'FREE' : '₹' + shipping}</span>
    </div>
    ${shipping > 0 ? `<div style="font-size:0.6rem;color:var(--gold);letter-spacing:0.05em;padding:0 0 0.6rem;">💡 Add ₹${(FREE_SHIPPING_THRESHOLD - subtotal).toLocaleString('en-IN')} more to qualify for free shipping</div>` : ''}`;

  totalEl.textContent = '₹' + grand.toLocaleString('en-IN');
  totalRow.style.display = 'flex';

  // Update Pay Now button label with total
  if (btnPay) {
    btnPay.textContent = `⚡ Pay Now — ₹${grand.toLocaleString('en-IN')}`;
    btnPay.disabled = false;
  }
  if (btnPartial) {
    const partial = partialPaymentTotals(cart);
    btnPartial.disabled = !partial.eligible;
    btnPartial.textContent = partial.eligible
      ? `Pay 10% Now — ₹${partial.deposit.toLocaleString('en-IN')} · Collect ₹${partial.balance.toLocaleString('en-IN')}`
      : 'Pay 10% Now · 90% on Delivery';
    if (partialNote) {
      partialNote.textContent = partial.eligible
        ? `Partial COD: customer pays ₹${partial.deposit.toLocaleString('en-IN')} now and ₹${partial.balance.toLocaleString('en-IN')} on delivery.`
        : `Available on orders above ₹599. Add ₹${(PARTIAL_PAYMENT_THRESHOLD + 1 - partial.total).toLocaleString('en-IN')} more to enable.`;
    }
  }
  if (btnCOD) {
    const codTotal = orderTotals(cart, 'cod').total;
    btnCOD.textContent = `🚚 Cash on Delivery — ₹${codTotal.toLocaleString('en-IN')}`;
    btnCOD.disabled = false;
  }
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Abandoned checkout capture ─────────────────────────────────────────────
let _abandonedTimer = null;
function collectPartialAddr() {
  const get = id => document.getElementById(id)?.value.trim() || '';
  const addr = get('ch-addr');
  const city = get('ch-city');
  const state = get('ch-state');
  const pin = get('ch-pin').replace(/\\D/g,'');
  return {
    name: get('ch-name'),
    phone: get('ch-phone'),
    email: get('ch-email'),
    address: [addr, city, state, pin].filter(Boolean).join(', '),
  };
}

function scheduleAbandonedCapture() {
  clearTimeout(_abandonedTimer);
  _abandonedTimer = setTimeout(() => saveAbandonedCheckout('open'), 900);
}

async function saveAbandonedCheckout(status = 'open', orderId = '') {
  const cart = getCart();
  const customer = collectPartialAddr();
  if (!cart.length || !(customer.email || customer.phone || customer.name)) return;
  const subtotal = cartSubtotal(cart);
  const shipping = calcShipping(subtotal);
  try {
    await fetch('/.netlify/functions/save-abandoned-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        session_id: checkoutSessionId(),
        cart,
        customer,
        shipping,
        status,
        order_id: orderId,
      }),
    });
  } catch(e) {
    console.warn('abandoned checkout capture skipped:', e.message);
  }
}

// ── Pincode → City / State ─────────────────────────────────────────────────
let _pinTimer = null;
function handlePin(val) {
  const msg = document.getElementById('pinMsg');
  clearTimeout(_pinTimer);
  val = val.replace(/\\D/g,'');
  if (val.length < 6) { msg.textContent = ''; msg.style.color = ''; return; }
  msg.textContent = 'Looking up pincode…';
  msg.style.color = '#a09080';
  _pinTimer = setTimeout(async () => {
    try {
      const res  = await fetch(`https://api.postalpincode.in/pincode/${val}`);
      const data = await res.json();
      if (data[0].Status === 'Success' && data[0].PostOffice?.length) {
        const po = data[0].PostOffice[0];
        document.getElementById('ch-city').value  = po.District || po.Division || po.Name || '';
        document.getElementById('ch-state').value = po.State || '';
        msg.textContent = '✓ ' + (po.District || po.Name) + ', ' + po.State;
        msg.style.color = '#8fa87a';
        return;
      }
    } catch(e){}
    msg.textContent = 'Pincode not found — enter city and state manually.';
    msg.style.color = '#c97a7a';
  }, 500);
}

// ── Collect + validate address ─────────────────────────────────────────────
function collectAddr() {
  const get = id => document.getElementById(id)?.value.trim() || '';
  const name  = get('ch-name');
  const phone = get('ch-phone');
  const email = get('ch-email');
  const addr  = get('ch-addr');
  const pin   = get('ch-pin').replace(/\\D/g,'');
  const city  = get('ch-city');
  const state = get('ch-state');

  if (!name)             { alert('Please enter your full name.'); return null; }
  if (phone.replace(/\\D/g,'').length < 10) { alert('Please enter a valid 10-digit phone number.'); return null; }
  if (!addr)             { alert('Please enter your delivery address.'); return null; }
  if (pin.length !== 6)  { alert('Please enter a valid 6-digit pincode.'); return null; }

  return {
    name, phone, email,
    address: [addr, city, state, pin].filter(Boolean).join(', '),
    pincode: pin, city, state,
  };
}

// ── Disable / enable buttons ───────────────────────────────────────────────
let _loadingMethod = '';
function setLoading(on, method = '') {
  _loadingMethod = on ? method : '';
  const pay = document.getElementById('btnPayNow');
  const cod = document.getElementById('btnCOD');
  if (pay) {
    pay.disabled = on;
    pay.classList.toggle('is-loading', on && method === 'online');
  }
  const partial = document.getElementById('btnPartial');
  if (partial) {
    partial.disabled = on || !partialPaymentTotals(getCart()).eligible;
    partial.classList.toggle('is-loading', on && method === 'partial');
  }
  if (cod) {
    cod.disabled = on;
    cod.classList.toggle('is-loading', on && method === 'cod');
  }
}

// ── Payment method radio swap ──────────────────────────────────────────────
function selectedPayMethod() {
  const sel = document.querySelector('input[name="payMethod"]:checked');
  return sel ? sel.value : 'phonepe';
}
document.addEventListener('change', e => {
  if (e.target?.name === 'payMethod') {
    document.querySelectorAll('.pay-method').forEach(m => m.classList.remove('active'));
    e.target.closest('.pay-method')?.classList.add('active');
    renderSummary();
  }
});

// ── Main submit ────────────────────────────────────────────────────────────
async function submitOrder(method) {
  const addr = collectAddr();
  if (!addr) return;
  setLoading(true, method);
  await saveAbandonedCheckout('open');

  if (method === 'online') {
    const pm = selectedPayMethod();
    if (pm === 'phonepe') {
      await doPhonePe(addr);
    } else {
      await doRazorpay(addr);
    }
  } else if (method === 'partial') {
    await doPartialPayment(addr);
  } else {
    await doCOD(addr);
  }
}

async function doPartialPayment(addr) {
  const cart = getCart();
  const partial = partialPaymentTotals(cart);
  if (!partial.eligible) {
    alert('Partial payment is available only for orders above ₹599.');
    setLoading(false);
    return;
  }
  const pm = selectedPayMethod();
  if (pm === 'razorpay') {
    await doRazorpay(addr, 'partial');
  } else {
    await doPhonePe(addr, 'partial');
  }
}

// ── PhonePe Standard Checkout ──────────────────────────────────────────────
async function doPhonePe(addr, paymentMode = 'online') {
  const cart = getCart();
  const totals = orderTotals(cart, 'online');
  const partial = partialPaymentTotals(cart);
  const isPartial = paymentMode === 'partial';
  const paymentMeta = isPartial ? {
    mode: 'partial_cod',
    full_total: partial.total,
    deposit: partial.deposit,
    balance: partial.balance,
    rate: partial.rate,
  } : {};
  try {
    const res = await fetch('/.netlify/functions/phonepe-create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cart: isPartial ? cartWithPaymentMeta(cart, paymentMeta) : cart,
        customer: { name: addr.name, phone: addr.phone, email: addr.email, address: addr.address },
        payment_mode: isPartial ? 'partial_cod' : 'online',
        coupon: isPartial ? '' : (totals.discount > 0 ? totals.couponCode : ''),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.success || !data.redirect_url) {
      throw new Error(data.error || 'Could not start PhonePe checkout');
    }
    // PhonePe takes over from here. The webhook + /phonepe-verify-status route
    // handle confirmation and the redirect back to /checkout/?paid=1&id=…
    window.location.href = data.redirect_url;
  } catch (e) {
    alert('PhonePe checkout failed: ' + e.message + '. Please try Razorpay or Cash on Delivery.');
    setLoading(false);
  }
}

// ── Razorpay ───────────────────────────────────────────────────────────────
async function doRazorpay(addr, paymentMode = 'online') {
  const cart = getCart();
  const totals = orderTotals(cart, 'online');
  const partial = partialPaymentTotals(cart);
  const isPartial = paymentMode === 'partial';
  const paymentMeta = isPartial ? {
    mode: 'partial_cod',
    full_total: partial.total,
    deposit: partial.deposit,
    balance: partial.balance,
    rate: partial.rate,
  } : {};
  const payable = isPartial ? partial.deposit : totals.total;
  const amtPaise = Math.round(payable * 100);

  try {
    const res = await fetch('/.netlify/functions/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: amtPaise, currency: 'INR',
        receipt: 'ic_' + Date.now(),
        notes: { customer_email: addr.email, customer_phone: addr.phone, customer_name: addr.name, coupon: isPartial ? '' : (totals.couponCode || ''), payment_mode: isPartial ? 'partial_cod' : 'online' },
      }),
    });
    if (!res.ok) throw new Error('Order creation failed');
    const order = await res.json();

    const options = {
      key:         window.RAZORPAY_KEY_ID,
      amount:      order.amount,
      currency:    order.currency,
      name:        'Ink & Chai',
      description: isPartial ? `10% deposit for Ink & Chai order` : `${cart.length} book${cart.length>1?'s':''}`,
      order_id:    order.id,
      prefill:     { name: addr.name, email: addr.email, contact: addr.phone },
      notes:       { shipping_address: addr.address },
      theme:       { color: '#c9a84c' },

      handler: async function(response) {
        try {
          const vRes = await fetch('/.netlify/functions/verify-payment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              razorpay_order_id:   response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature:  response.razorpay_signature,
              cart: isPartial ? cartWithPaymentMeta(cart, paymentMeta) : cart,
              customer: addr,
              amount: amtPaise,
              shipping: isPartial ? partial.shipping : totals.shipping,
              coupon: isPartial ? '' : totals.couponCode,
              discount: isPartial ? 0 : totals.discount,
              payment_mode: isPartial ? 'partial_cod' : 'online',
            }),
          });
          if (!vRes.ok) throw new Error('Verification failed');
          await saveAbandonedCheckout('converted', response.razorpay_order_id);
          localStorage.removeItem(ABANDONED_SESSION_KEY);
          clearCart();
          await autoLogin(addr.email, addr.name, addr.phone);
          showSuccess('paid', response.razorpay_payment_id, addr);
        } catch(e) {
          alert('Payment received but verification failed. Please contact support@inkandchai.in');
          setLoading(false);
        }
      },
      modal: { ondismiss: () => setLoading(false) },
    };

    const rzp = new Razorpay(options);
    rzp.on('payment.failed', r => { alert('Payment failed: ' + r.error.description); setLoading(false); });
    rzp.open();

  } catch(e) {
    alert('Could not start checkout: ' + e.message);
    setLoading(false);
  }
}

// ── Cash on Delivery ───────────────────────────────────────────────────────
async function doCOD(addr) {
  const cart     = getCart();
  const totals = orderTotals(cart, 'cod');
  if (appliedCouponCode && couponDiscount(cartSubtotal(cart), 'cod').message) {
    alert(appliedCouponCode + ' is valid only for Pay Now orders. Please use Pay Now to get the discount, or clear the coupon for COD.');
    setLoading(false);
    return;
  }

  try {
    const res = await fetch('/.netlify/functions/cod-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cart,
        customer: { name: addr.name, phone: addr.phone, email: addr.email, address: addr.address },
        amount: totals.total, shipping: totals.shipping,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to place order');

    await saveAbandonedCheckout('converted', data.order_id);
    localStorage.removeItem(ABANDONED_SESSION_KEY);
    clearCart();
    await autoLogin(addr.email, addr.name, addr.phone);
    showSuccess('cod', data.order_id, addr);

  } catch(e) {
    alert('Could not place order: ' + e.message);
    setLoading(false);
  }
}

// ── Auto-login after order ─────────────────────────────────────────────────
async function autoLogin(email, name, phone) {
  // Security: do not create a customer session just because an email was typed
  // during checkout. Customers can sign in from My Orders using an emailed link.
  return;
}

// ── Success screen ─────────────────────────────────────────────────────────
function trackGoogleAdsPurchase(orderId) {
  if (!orderId || typeof gtag !== 'function') return;
  const key = 'iac_google_ads_purchase_' + orderId;
  if (localStorage.getItem(key)) return;
  gtag('event', 'conversion', {
    send_to: 'AW-18119332653/dQPCCJ7L8KQcEK2m_L9D',
    transaction_id: String(orderId),
  });
  localStorage.setItem(key, '1');
}

function showSuccess(type, orderId, addr) {
  trackGoogleAdsPurchase(orderId);
  document.getElementById('checkoutScreen').style.display = 'none';
  const s = document.getElementById('successScreen');
  s.style.display = 'block';

  const isPaid = type === 'paid';
  s.innerHTML = `
    <div class="success-icon">${isPaid ? '✦' : '🚚'}</div>
    <h2 class="success-title">${isPaid ? 'Payment Confirmed!' : 'Order Placed!'}</h2>
    <p class="success-sub">
      ${isPaid
        ? 'Thank you for your purchase. Your books are on their way.'
        : `Hi ${esc(addr.name.split(' ')[0])}, your books are on their way.<br/>Pay cash when they arrive.`}
    </p>
    <p class="success-id">${isPaid ? 'Payment ID' : 'Order ID'}: ${esc(orderId)}</p>
    ${addr.email ? `
    <div class="success-email-box">
      <p style="font-size:0.68rem;color:var(--gold);margin-bottom:0.35rem;letter-spacing:0.07em;">
        📧 Confirmation sent to ${esc(addr.email)}
      </p>
      <p style="font-size:0.64rem;color:var(--cream-dim);line-height:1.75;margin:0;">
        Your order details have been emailed to you. Click
        <strong style="color:var(--white);">My Orders</strong> on
        <a href="/" style="color:var(--gold);">inkandchai.in</a> to track your order anytime.
      </p>
    </div>` : ''}
    <a href="/" class="btn-home">← Continue Shopping</a>
  `;
}

// ── PhonePe redirect-back handler ──────────────────────────────────────────
// PhonePe → /phonepe-verify-status → /checkout/?paid=1&id=… (or ?failed=1)
(function() {
  const p = new URLSearchParams(location.search);
  if (p.get('paid') === '1' && p.get('id')) {
    clearCart();
    // Show success screen — try to read customer email from saved abandoned checkout
    let savedEmail = '';
    try {
      const sess = JSON.parse(localStorage.getItem('iac_checkout_lead') || '{}');
      savedEmail = sess.email || sess.customer_email || '';
    } catch {}
    showSuccess('paid', p.get('id'), { email: savedEmail });
    // Clean URL so refresh doesn't re-trigger success
    history.replaceState({}, '', '/checkout/');
    return;
  }
  if (p.get('failed') === '1') {
    const code = p.get('code') || '';
    setTimeout(() => alert('PhonePe payment was cancelled or failed' + (code ? ' (' + code + ')' : '') + '. Please try again or use Cash on Delivery.'), 100);
    history.replaceState({}, '', '/checkout/');
  }
})();

// ── Init ───────────────────────────────────────────────────────────────────
renderSummary();

['ch-name','ch-phone','ch-email','ch-addr','ch-pin','ch-city','ch-state'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', scheduleAbandonedCapture);
  el.addEventListener('blur', () => saveAbandonedCheckout('open'));
});

// Pre-fill from Supabase profile if logged in
(async () => {
  if (!window.supabase || !window.SUPABASE_URL || window.SUPABASE_URL === 'SUPABASE_URL_PLACEHOLDER') return;
  try {
    const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    const email = session.user?.email;
    const { data: profile } = await sb.from('profiles').select('*').eq('id', session.user.id).single();
    const fill = (id, val) => { const el = document.getElementById(id); if (el && val && !el.value) el.value = val; };
    fill('ch-name',  profile?.name);
    fill('ch-email', email);
    fill('ch-phone', profile?.phone);
    fill('ch-addr',  profile?.address);
  } catch(e) {}
})();
</script>
</body>
</html>"""

CHECKOUT_HTML = CHECKOUT_HTML.replace("RAZORPAY_PUB_KEY_PLACEHOLDER", razorpay_key)
CHECKOUT_HTML = CHECKOUT_HTML.replace("SUPABASE_URL_PLACEHOLDER",     os.environ.get("SUPABASE_URL", ""))
CHECKOUT_HTML = CHECKOUT_HTML.replace("SUPABASE_ANON_KEY_PLACEHOLDER",os.environ.get("SUPABASE_ANON_KEY", ""))

checkout_out = Path(__file__).parent / "public" / "checkout" / "index.html"
checkout_out.parent.mkdir(parents=True, exist_ok=True)
checkout_out.write_text(with_meta_pixel(CHECKOUT_HTML), encoding="utf-8")
print(f"Generated: {checkout_out}")

# ── Collection / Category landing page ──────────────────────────────────────
# Single template that reads ?id=<slug> (collection) or ?name=<cat> (category)
# from the URL, finds matching books from BOOKS_DATA, and renders them.
COLLECTION_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"/>
<meta http-equiv="Pragma" content="no-cache"/>
<meta http-equiv="Expires" content="0"/>
<title>Collection — Ink &amp; Chai</title>
<link rel="icon" type="image/png" sizes="32x32" href="/images/favicon-32.png"/>
<link rel="icon" type="image/png" sizes="96x96" href="/images/favicon-96.png"/>
<link rel="apple-touch-icon" href="/images/apple-touch-icon.png"/>
<link rel="manifest" href="/manifest.json"/>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400;1,600&family=Montserrat:wght@300;400;500;600&display=swap" rel="stylesheet"/>
<script>
  (function(){ try { var t = localStorage.getItem('iac_theme'); if (t === 'light') document.documentElement.setAttribute('data-theme','light'); } catch(e){ /* dark default */ } })();
  function toggleTheme(){ var c = document.documentElement.getAttribute('data-theme'); var n = c === 'light' ? 'dark' : 'light'; if(n) document.documentElement.setAttribute('data-theme', n); else document.documentElement.removeAttribute('data-theme'); try { localStorage.setItem('iac_theme', n); } catch(e){} }
</script>
<style>
:root{--bg:#0d0b08;--bg2:#141210;--bg3:#1c1916;--gold:#c9a84c;--gold-light:#e8c97a;--gold-dim:#7a6330;--cream:#f0e8d8;--cream-dim:#a09080;--white:#faf7f2;--border:rgba(201,168,76,0.18)}
html[data-theme="light"]{--bg:#faf7f2;--bg2:#f3ece0;--bg3:#ffffff;--gold:#8a6a1f;--gold-light:#b8902c;--gold-dim:#6a4f10;--cream:#2a2018;--cream-dim:#5a4a38;--white:#0d0b08;--border:rgba(138,106,31,0.28)}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--cream);font-family:'Montserrat',sans-serif;font-weight:300;min-height:100vh}
nav{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:1.2rem 4rem;background:rgba(13,11,8,0.97);border-bottom:1px solid var(--border);backdrop-filter:blur(12px)}
html[data-theme="light"] nav{background:rgba(250,247,242,0.97)}
.nav-logo{display:inline-flex;align-items:center;gap:0.5rem;font-family:'Cormorant Garamond',serif;font-size:1.5rem;font-weight:600;letter-spacing:0.08em;color:var(--gold);text-decoration:none}
.nav-logo .logo-img{height:38px;width:auto;display:block}
.nav-logo .logo-light{display:none}
html[data-theme="light"] .nav-logo .logo-dark{display:none}
html[data-theme="light"] .nav-logo .logo-light{display:block}
@media(max-width:780px){.nav-logo .logo-img{height:32px}}
.nav-back{font-size:0.62rem;letter-spacing:0.2em;text-transform:uppercase;color:var(--cream-dim);text-decoration:none;transition:color 0.3s}
.nav-back:hover{color:var(--gold)}
.btn-nav{font-family:'Montserrat',sans-serif;font-size:0.62rem;letter-spacing:0.22em;text-transform:uppercase;padding:0.55rem 1.4rem;border:1px solid var(--gold-dim);color:var(--gold);background:transparent;cursor:pointer;transition:all 0.3s;text-decoration:none}
.btn-nav:hover{background:var(--gold);color:var(--bg)}
.theme-toggle{background:transparent;border:1px solid var(--gold-dim);color:var(--gold);width:34px;height:34px;border-radius:50%;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:0.85rem;transition:all 0.3s}
.theme-toggle:hover{background:var(--gold);color:var(--bg);transform:rotate(20deg)}
.theme-toggle .sun{display:none}
html[data-theme="light"] .theme-toggle .moon{display:none}
html[data-theme="light"] .theme-toggle .sun{display:inline}
.collection-hero{padding:4rem 2rem 2.5rem;max-width:1200px;margin:0 auto;text-align:center}
.coll-eyebrow{font-size:0.62rem;letter-spacing:0.35em;text-transform:uppercase;color:var(--gold);margin-bottom:1rem}
.coll-h1{font-family:'Cormorant Garamond',serif;font-size:clamp(2.4rem,5vw,4rem);font-weight:300;color:var(--white);line-height:1.1;margin-bottom:1rem}
.coll-h1 em{font-style:italic;color:var(--gold-light)}
.coll-sub{font-size:0.85rem;color:var(--cream-dim);max-width:640px;margin:0 auto;line-height:1.8}
.coll-meta{display:flex;justify-content:center;gap:2rem;margin-top:2rem;font-size:0.62rem;letter-spacing:0.2em;text-transform:uppercase;color:var(--gold)}
.crumb{padding:0 2rem 1rem;max-width:1200px;margin:0 auto;font-size:0.6rem;letter-spacing:0.22em;text-transform:uppercase;color:var(--gold-dim)}
.crumb a{color:var(--gold);text-decoration:none}
.crumb a:hover{color:var(--gold-light)}
.toolbar{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;max-width:1200px;margin:0 auto;padding:1rem 2rem;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.toolbar input,.toolbar select{background:var(--bg2);border:1px solid var(--border);color:var(--cream);padding:0.5rem 0.9rem;font-family:'Montserrat',sans-serif;font-size:0.7rem;outline:none}
.toolbar input{flex:1;max-width:280px}
.toolbar input:focus,.toolbar select:focus{border-color:var(--gold)}
.tools-right{display:flex;gap:0.6rem;align-items:center}
.count-pill{font-size:0.6rem;letter-spacing:0.2em;text-transform:uppercase;color:var(--cream-dim)}
.count-pill b{color:var(--gold);font-weight:500}
.book-grid{max-width:1200px;margin:0 auto;padding:3rem 2rem 6rem;display:grid;grid-template-columns:repeat(4,1fr);gap:2rem}
@media(max-width:980px){.book-grid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:780px){.book-grid{grid-template-columns:repeat(2,1fr);gap:1.2rem;padding:2rem 1rem 4rem}.collection-hero{padding:2.5rem 1rem 1.5rem}.toolbar{padding:0.8rem 1rem}.nav-back{display:none}nav{padding:1rem}}
.book-card{cursor:pointer;transition:transform 0.3s}
.book-card:hover{transform:translateY(-4px)}
.book-cover{aspect-ratio:2/3;background:#1a1208;border:1px solid var(--border);overflow:hidden;margin-bottom:1rem;position:relative}
html[data-theme="light"] .book-cover{background:#f0e8d4}
.book-cover img{width:100%;height:100%;object-fit:contain;transition:transform 0.4s;background:#1a1208}
.book-card:hover .book-cover img{transform:scale(1.05)}
.book-name{font-family:'Cormorant Garamond',serif;font-size:0.95rem;color:var(--cream);line-height:1.3;margin-bottom:0.3rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.book-author{font-size:0.65rem;color:var(--cream-dim);letter-spacing:0.05em;margin-bottom:0.5rem}
.book-price{color:var(--gold);font-size:0.95rem;font-weight:500;font-family:'Cormorant Garamond',serif}
.book-orig{font-size:0.7rem;color:var(--cream-dim);text-decoration:line-through;margin-left:0.5rem}
.empty{text-align:center;padding:6rem 2rem;color:var(--cream-dim)}
.empty h2{font-family:'Cormorant Garamond',serif;font-size:1.8rem;color:var(--white);margin-bottom:1rem}
.empty a{color:var(--gold);text-decoration:none}
.promo-banner{background:linear-gradient(90deg,#1a1410,#2a1f15,#1a1410);border-bottom:1px solid rgba(201,168,76,0.25);padding:0.55rem 1rem;text-align:center;font-size:0.66rem;letter-spacing:0.12em;color:#f0e8d8;font-family:'Montserrat',sans-serif;position:relative;z-index:200}
.promo-banner strong{color:#c9a84c;font-weight:600;letter-spacing:0.18em}
.promo-banner code{background:rgba(201,168,76,0.18);color:#c9a84c;padding:0.15rem 0.55rem;border:1px dashed rgba(201,168,76,0.5);font-family:'Montserrat',sans-serif;font-size:0.62rem;letter-spacing:0.15em;margin-left:0.5rem}
html[data-theme="light"] .promo-banner{background:linear-gradient(90deg,#fff8e6,#fbeec8,#fff8e6);color:#5a4a18}
html[data-theme="light"] .promo-banner code{background:rgba(138,106,31,0.12);color:#6a4f10;border-color:rgba(138,106,31,0.4)}
@media(max-width:780px){.promo-banner{display:none}}
.wa-float{position:fixed;bottom:22px;left:22px;width:54px;height:54px;border-radius:50%;background:#25d366;color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(37,211,102,0.45);z-index:250;cursor:pointer;text-decoration:none;transition:transform 0.2s}
.wa-float:hover{transform:scale(1.08)}
@media(max-width:780px){.wa-float{bottom:88px;left:14px;width:46px;height:46px}}
.mob-nav{display:none}
@media(max-width:780px){
  .mob-nav{display:flex;position:fixed;top:auto!important;bottom:0;left:0;right:0;height:auto;z-index:9998;background:rgba(13,11,8,0.97);border-top:1px solid rgba(201,168,76,0.25);padding:0.5rem 0 calc(0.5rem + env(safe-area-inset-bottom,0px));backdrop-filter:blur(14px);box-shadow:0 -4px 20px rgba(0,0,0,0.4)}
  body{padding-bottom:64px}
}
html[data-theme="light"] .mob-nav{background:rgba(250,247,242,0.97);border-top-color:rgba(138,106,31,0.3)}
.mob-nav a,.mob-nav button{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:0.45rem 0;background:transparent;border:none;color:var(--cream-dim);font-family:'Montserrat',sans-serif;font-size:0.55rem;letter-spacing:0.12em;text-transform:uppercase;cursor:pointer;text-decoration:none;transition:color 0.2s}
.mob-nav a:active,.mob-nav button:active{color:var(--gold)}
.mob-nav .mn-icon{font-size:1.25rem;line-height:1}
</style>
</head>
<body>
<div class="promo-banner"><strong>✦ PREPAID OFFERS</strong> 10% ₹499+ &nbsp;·&nbsp; 12% ₹999+ &nbsp;·&nbsp; 15% ₹1499+</div>
<nav class="mob-nav" aria-label="Mobile navigation">
  <a href="/" title="Home"><span class="mn-icon">⌂</span><span>Home</span></a>
  <a href="/" title="My Orders"><span class="mn-icon">📦</span><span>Orders</span></a>
  <a href="/" title="Cart"><span class="mn-icon">🛒</span><span>Cart</span></a>
</nav>
<a class="wa-float" href="https://wa.me/919217175546" target="_blank" rel="noopener" title="Chat on WhatsApp"><svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg></a>
<nav>
  <a class="nav-logo" href="/" aria-label="Ink and Chai — home">
    <img class="logo-img logo-dark"  src="/images/logo-light.png" alt="Ink &amp; Chai logo" width="120" height="38"/>
    <img class="logo-img logo-light" src="/images/logo.png"       alt="" width="120" height="38" aria-hidden="true"/>
  </a>
  <a class="nav-back" href="/">← Back to home</a>
  <div style="display:flex;gap:0.8rem;align-items:center;">
    <button class="theme-toggle" onclick="toggleTheme()" title="Toggle light/dark mode"><span class="moon">🌙</span><span class="sun">☀️</span></button>
    <a class="btn-nav" href="/">Catalogue</a>
  </div>
</nav>
<div id="page"></div>
<script>
const BOOKS = BOOKS_DATA_PLACEHOLDER;
const COLLECTIONS = COLLECTIONS_DATA_PLACEHOLDER;
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function slugifyName(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').replace(/-+/g,'-')}

const params = new URLSearchParams(location.search);
const pathParts = location.pathname.split('/').filter(Boolean);
const pathType = pathParts[0] || '';
const pathSlug = pathParts[1] ? decodeURIComponent(pathParts[1]) : '';
const collId = params.get('id') || (pathType === 'collection' ? pathSlug : '');
let catName = params.get('name') || '';
if (!catName && pathType === 'category' && pathSlug) {
  const cats = Array.from(new Set(BOOKS.map(b => b.cat).filter(Boolean)));
  catName = cats.find(c => slugifyName(c) === pathSlug) || '';
}

let title = '', subtitle = '', crumbLabel = '', books = [];

if (collId) {
  const c = COLLECTIONS.find(x => x.slug === collId);
  if (c) {
    title = c.name;
    crumbLabel = c.name;
    const set = new Set((c.cats||[]).map(x => x.toLowerCase()));
    books = BOOKS.filter(b => set.has((b.cat||'').toLowerCase()));
    subtitle = `Curated picks from ${(c.cats||[]).length} matching categories.`;
    document.title = c.name + ' — Ink & Chai';
  }
} else if (catName) {
  title = catName;
  crumbLabel = catName;
  books = BOOKS.filter(b => (b.cat||'').toLowerCase() === catName.toLowerCase());
  subtitle = `All books in the ${catName} category.`;
  document.title = catName + ' — Ink & Chai';
}

if (!books.length) {
  document.getElementById('page').innerHTML = `
    <div class="empty">
      <h2>Nothing here yet</h2>
      <p>This collection or category is empty. <a href="/">Browse all books →</a></p>
    </div>`;
} else {
  document.getElementById('page').innerHTML = `
    <div class="collection-hero">
      <div class="coll-eyebrow">${collId ? 'Curated Collection' : 'Category'}</div>
      <h1 class="coll-h1">${esc(title.split(' & ')[0])}${title.includes(' & ') ? ` <em>&amp; ${esc(title.split(' & ')[1])}</em>` : ''}</h1>
      <p class="coll-sub">${esc(subtitle)}</p>
      <div class="coll-meta"><span><b style="color:var(--gold-light)">${books.length}</b> Books</span></div>
    </div>
    <div class="crumb"><a href="/">Home</a> &nbsp;/&nbsp; ${collId ? '<a href="/#collections">Collections</a>' : '<a href="/#categories">Categories</a>'} &nbsp;/&nbsp; ${esc(crumbLabel)}</div>
    <div class="toolbar">
      <input id="qfilter" type="text" placeholder="Filter within this collection…" oninput="renderGrid()"/>
      <div class="tools-right">
        <span class="count-pill"><b id="visCount">${books.length}</b> shown</span>
        <select id="sort" onchange="renderGrid()">
          <option value="popular">Popular</option>
          <option value="price-asc">Price: Low → High</option>
          <option value="price-desc">Price: High → Low</option>
          <option value="alpha">A → Z</option>
        </select>
      </div>
    </div>
    <div class="book-grid" id="grid"></div>`;
  renderGrid();
}

function renderGrid() {
  const q = (document.getElementById('qfilter')?.value || '').toLowerCase().trim();
  const sort = document.getElementById('sort')?.value || 'popular';
  let list = books.filter(b => !q || (b.t + ' ' + (b.a||'')).toLowerCase().includes(q));
  const priceOf = b => parseFloat((b.p||'').replace(/[^0-9.]/g,''))||0;
  if (sort === 'price-asc')  list.sort((a,b) => priceOf(a) - priceOf(b));
  if (sort === 'price-desc') list.sort((a,b) => priceOf(b) - priceOf(a));
  if (sort === 'alpha')      list.sort((a,b) => (a.t||'').localeCompare(b.t||''));
  document.getElementById('visCount').textContent = list.length;
  document.getElementById('grid').innerHTML = list.map(b => `
    <div class="book-card" onclick="location.href='/product/${b.slug}/'">
      <div class="book-cover">${b.img ? `<img src="${esc(b.img)}" alt="${esc(b.t)}" loading="lazy" onerror="this.style.display='none'"/>` : ''}</div>
      <div class="book-name">${esc(b.t)}</div>
      <div class="book-author">${esc(b.a||'')}</div>
      <div><span class="book-price">${esc(b.p)}</span>${b.op ? `<span class="book-orig">${esc(b.op)}</span>` : ''}</div>
    </div>
  `).join('');
}
</script>
</body>
</html>"""

# Inject the same slim books data + collection metadata
COLLECTION_HTML = COLLECTION_HTML.replace("BOOKS_DATA_PLACEHOLDER", books_js)
COLLECTION_HTML = COLLECTION_HTML.replace("COLLECTIONS_DATA_PLACEHOLDER", json.dumps(coll_data, ensure_ascii=False))
COLLECTION_HTML = with_reader_activity(COLLECTION_HTML)

coll_out = Path(__file__).parent / "public" / "collection" / "index.html"
coll_out.parent.mkdir(parents=True, exist_ok=True)
coll_out.write_text(with_meta_pixel(COLLECTION_HTML), encoding="utf-8")
print(f"Generated: {coll_out}")

# Same template handles category pages — just write a copy under /category/
cat_out = Path(__file__).parent / "public" / "category" / "index.html"
cat_out.parent.mkdir(parents=True, exist_ok=True)
cat_out.write_text(with_meta_pixel(COLLECTION_HTML), encoding="utf-8")
print(f"Generated: {cat_out}")

# ── Google Merchant Center Product Feed (feed.xml) ───────────────────────────
def xml_escape(s):
    return (str(s or '')
            .replace('&', '&amp;')
            .replace('<', '&lt;')
            .replace('>', '&gt;')
            .replace('"', '&quot;'))

SITE = "https://inkandchai.in"
items = []
for b in slim:
    price = (b.get("p") or "").replace("₹", "").replace(",", "").strip()
    try:
        price_val = f"{float(price):.2f} INR"
    except Exception:
        price_val = "0.00 INR"
        if price_val == "0.00 INR":
            continue   # skip books with no price

    img = feed_image_by_slug.get(b.get("slug", "")) or crawlable_image_url(b.get("img", ""))

    slug = b.get("slug", "")
    link = f"{SITE}/product/{slug}/"

    # Google Merchant Center caps <g:id> at 50 characters. Our slug can be up
    # to 61 chars (55-char title prefix + "-" + 5-char shopify suffix). When too
    # long, truncate the title portion but PRESERVE the unique shopify suffix
    # at the end so two products never collide.
    feed_id = slug
    if len(feed_id) > 50:
        if "-" in feed_id:
            prefix, suffix = feed_id.rsplit("-", 1)
            max_prefix = 50 - 1 - len(suffix)
            feed_id = prefix[:max_prefix].rstrip("-") + "-" + suffix
        else:
            feed_id = feed_id[:50]

    desc = xml_escape(b.get("desc") or b.get("t") or "")
    if not desc:
        desc = f"Buy {xml_escape(b.get('t',''))} by {xml_escape(b.get('a',''))} online."

    items.append(f"""    <item>
      <g:id>{xml_escape(feed_id)}</g:id>
      <g:title>{xml_escape(b.get('t',''))}</g:title>
      <g:description>{desc}</g:description>
      <g:link>{link}</g:link>
      <g:image_link>{xml_escape(img)}</g:image_link>
      <g:condition>new</g:condition>
      <g:availability>in stock</g:availability>
      <g:price>{price_val}</g:price>
      <g:brand>{xml_escape(b.get('a') or 'Ink &amp; Chai')}</g:brand>
      <g:google_product_category>Media &gt; Books</g:google_product_category>
      <g:product_type>{xml_escape(b.get('cat','Books'))}</g:product_type>
      {f"<g:identifier_exists>yes</g:identifier_exists><g:isbn>{xml_escape(b.get('isbn',''))}</g:isbn>" if b.get('isbn') else "<g:identifier_exists>no</g:identifier_exists>"}
    </item>""")

feed_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Ink &amp; Chai — Books Online India</title>
    <link>{SITE}</link>
    <description>Buy books online at Ink &amp; Chai. Pan-India delivery. Secure online payment via UPI, cards and net banking.</description>
{chr(10).join(items)}
  </channel>
</rss>"""

feed_out = Path(__file__).parent / "public" / "feed.xml"
feed_out.write_text(feed_xml, encoding="utf-8")
print(f"Generated: {feed_out}  ({len(feed_xml.encode())//1024} KB, {len(items)} products)")

# ── SEO: sitemap.xml + robots.txt ─────────────────────────────────────────────
from datetime import datetime
SITE = "https://inkandchai.in"
TODAY = datetime.utcnow().strftime("%Y-%m-%d")

# Collect URLs: home, static pages, every collection slug, every category, every product
static_urls = [
    (SITE + "/",                "1.0",  "daily"),
    (SITE + "/hindi-books/",    "0.95", "weekly"),
    (SITE + "/self-help-books/","0.95", "weekly"),
    (SITE + "/bestsellers/",    "0.95", "daily"),
    (SITE + "/new-arrivals/",   "0.9",  "daily"),
    (SITE + "/book-combos/",    "0.9",  "weekly"),
    (SITE + "/hindi-self-help-books/", "0.9", "weekly"),
    (SITE + "/business-books-hindi/",  "0.8", "weekly"),
    (SITE + "/manga-books-india/",     "0.8", "weekly"),
    (SITE + "/cod-books-online/",      "0.8", "weekly"),
    (SITE + "/track/",          "0.7",  "weekly"),
    (SITE + "/terms/",          "0.4",  "yearly"),
    (SITE + "/privacy-policy/", "0.4",  "yearly"),
    (SITE + "/refund-policy/",  "0.4",  "yearly"),
    (SITE + "/return-policy/",  "0.4",  "yearly"),
    (SITE + "/shipping-policy/","0.4",  "yearly"),
]
url_entries = []
for url, prio, freq in static_urls:
    url_entries.append(f"  <url><loc>{url}</loc><lastmod>{TODAY}</lastmod><changefreq>{freq}</changefreq><priority>{prio}</priority></url>")

# Product URLs — every book
for b in slim:
    purl = f"{SITE}/product/{b['slug']}/"
    img  = feed_image_by_slug.get(b.get('slug', '')) or b.get('img', '')
    img_xml = ""
    if img:
        img_abs = crawlable_image_url(img)
        image_title = re.sub(r"\s+", " ", (b['t'] or '')).strip()
        img_xml = f"<image:image><image:loc>{img_abs.replace('&','&amp;')}</image:loc><image:title>{image_title.replace('&','&amp;').replace('<','&lt;')[:200]}</image:title></image:image>"
    url_entries.append(f"  <url><loc>{purl.replace('&','&amp;')}</loc><lastmod>{TODAY}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>{img_xml}</url>")

# Collection URLs
for c in coll_data:
    curl = f"{SITE}/collection/?id={c['slug']}"
    url_entries.append(f"  <url><loc>{curl}</loc><lastmod>{TODAY}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>")

# Category URLs (top categories with >= 5 books)
for c in all_cats:
    if c['count'] < 5: continue
    caturl = f"{SITE}/category/{slugify(c['name'])}/"
    url_entries.append(f"  <url><loc>{caturl}</loc><lastmod>{TODAY}</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>")

sitemap_xml = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n'
    + "\n".join(url_entries) + "\n"
    "</urlset>\n"
)
sitemap_out = Path(__file__).parent / "public" / "sitemap.xml"
sitemap_out.write_text(sitemap_xml, encoding="utf-8")
print(f"Generated: {sitemap_out}  ({len(sitemap_xml.encode())//1024} KB, {len(url_entries)} URLs)")

# robots.txt
robots_txt = f"""User-agent: *
Allow: /
Disallow: /admin/
Disallow: /.netlify/

Sitemap: {SITE}/sitemap.xml
"""
robots_out = Path(__file__).parent / "public" / "robots.txt"
robots_out.write_text(robots_txt, encoding="utf-8")
print(f"Generated: {robots_out}")

# Server-side lookup for proxied legacy CDN images. Public pages only expose
# opaque image IDs, while the source URLs stay inside the Netlify function.
image_map_out = Path(__file__).parent / "netlify" / "functions" / "image-map.json"
image_map_out.parent.mkdir(parents=True, exist_ok=True)
image_map_out.write_text(json.dumps(IMAGE_PROXY_MAP, ensure_ascii=False, sort_keys=True), encoding="utf-8")
print(f"Generated: {image_map_out}  ({len(IMAGE_PROXY_MAP)} proxied images)")
