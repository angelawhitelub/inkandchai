"""
Generates the Ink & Chai homepage with real book data
from ALL_BOOKS.json.
"""

import hashlib, json, os, re
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

# Typography — bookshop-grade stack:
#   • Fraunces (display)  — distinctive old-style serif with optical-size axis,
#     evokes letterpress headings without feeling pastiche
#   • Lora (body serif)   — designed for long-form reading on screens,
#     so product descriptions and articles feel like a book page
#   • Inter (UI sans)     — crisp at small sizes, great Hindi+Latin pairing
#   • Cormorant Garamond  — kept as fallback for any legacy hardcoded usage
#   • Noto Sans Devanagari — Hindi script support across all UI
FONT_GOOGLE_URL = (
    "https://fonts.googleapis.com/css2?"
    "family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,400;1,9..144,500"
    "&family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500"
    "&family=Inter:wght@300;400;500;600;700"
    "&family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400"
    "&family=Noto+Sans+Devanagari:wght@400;500;600;700"
    "&display=swap"
)
FONT_GOOGLE_URL_SIMPLE = (
    "https://fonts.googleapis.com/css2?"
    "family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700"
    "&family=Lora:ital,wght@0,400;0,500;0,600;1,400"
    "&family=Inter:wght@300;400;500;600;700"
    "&family=Cormorant+Garamond:wght@400;600"
    "&family=Noto+Sans+Devanagari:wght@400;500;600;700"
    "&display=swap"
)

def inject_font_links(html: str) -> str:
    """Replace font URL placeholders with the canonical Google Fonts links."""
    html = html.replace("FONT_GOOGLE_URL_PLACEHOLDER", FONT_GOOGLE_URL)
    html = html.replace("FONT_GOOGLE_URL_SIMPLE_PLACEHOLDER", FONT_GOOGLE_URL_SIMPLE)
    # Legacy URLs from older templates (space in family name breaks loading)
    _legacy = (
        "https://fonts.googleapis.com/css2?"
        "family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400;1,600"
        "&family=Montserrat:wght@300;400;500;600&display=swap",
        "https://fonts.googleapis.com/css2?"
        "family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400;1,600"
        "&family=Montserrat:wght@300;400;500;600;700&display=swap",
        "https://fonts.googleapis.com/css2?"
        "family=Cormorant+Garamond:wght@400;600&family=Montserrat:wght@300;400;600;700&display=swap",
        "https://fonts.googleapis.com/css2?"
        "family=Cormorant+Garamond:wght@400;600&family=Montserrat:wght@300;400;500;600&display=swap",
    )
    for old in _legacy:
        html = html.replace(old, FONT_GOOGLE_URL_SIMPLE)
    # Broken URLs after accidental Montserrat→Source Sans 3 replace in hrefs
    html = html.replace(
        "family=Source Sans 3:wght@300;400;500;600&display=swap",
        FONT_GOOGLE_URL_SIMPLE.split("css2?", 1)[1],
    )
    html = html.replace(
        "family=Source Sans 3:wght@300;400;600;700&display=swap",
        FONT_GOOGLE_URL_SIMPLE.split("css2?", 1)[1],
    )
    return html

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
    if str(shopify_id or "") == "CUSTOM-SHAKTI-GOGGINS-COMBO-3-HI":
        return "shakti-ke-48-niyam-cant-hurt-me-never-finished-hindi-combo-3-books"
    if str(shopify_id or "") == "CUSTOM-HIDDEN-HINDU-TRILOGY-3":
        return "hidden-hindu-complete-trilogy-3-books-akshat-gupta"
    if str(shopify_id or "") == "CUSTOM-COLLEEN-HOOVER-STARTER-3":
        return "colleen-hoover-3-book-starter-set-it-ends-verity-reminders"
    if str(shopify_id or "") == "CUSTOM-ANA-HUANG-TWISTED-SPECIAL-3":
        return "ana-huang-twisted-special-editions-3-pack"
    if str(shopify_id or "") == "CUSTOM-ROBERT-GREENE-POWER-TRILOGY-3":
        return "robert-greene-power-trilogy-48-laws-human-nature-seduction"
    if str(shopify_id or "") == "CUSTOM-MARK-DOUGLAS-TRADING-DUO-2":
        return "mark-douglas-trading-duo-zone-disciplined-trader"
    if str(shopify_id or "") == "CUSTOM-HINDI-MOTIVATION-BIG-4":
        return "hindi-motivation-big-4-atomic-habits-rich-dad-shakti-think"
    if str(shopify_id or "") == "CUSTOM-FELUDA-4-PACK":
        return "feluda-complete-mysteries-4-book-set-satyajit-ray"
    if str(shopify_id or "") == "CUSTOM-STOIC-ESSENTIALS-TRIO-3":
        return "stoic-essentials-trio-ego-daily-stoic-meditations"
    if str(shopify_id or "") == "CUSTOM-ENID-BLYTON-FAMOUS-FIVE-1-3":
        return "enid-blyton-famous-five-books-1-2-3-starter-set"
    if str(shopify_id or "") == "CUSTOM-WEALTH-PACK-299":
        return "wealth-starter-pack-psychology-of-money-rich-dad-think-grow"
    if str(shopify_id or "") == "CUSTOM-KIDS-ACTIVITY-4-PACK":
        return "kids-activity-4-pack-pete-cat-wipe-clean-learning"
    if str(shopify_id or "") == "CUSTOM-CLASSIC-POCKET-TRIO-3":
        return "classic-pocket-trio-diary-young-girl-alice-meditations"
    if str(shopify_id or "") == "CUSTOM-OSHO-DUO-2":
        return "osho-duo-dhyan-darshan-nari-aur-kranti"
    if str(shopify_id or "") == "CUSTOM-ANA-HUANG-KINGS-SIN-1-3":
        return "ana-huang-kings-of-sin-series-books-1-2-3"
    if str(shopify_id or "") == "CUSTOM-OFF-CAMPUS-5-ELLE-KENNEDY":
        return "off-campus-complete-5-book-collection-elle-kennedy"
    if str(shopify_id or "") == "CUSTOM-PSYCH-MONEY-THINKING-FAST-HINDI-2":
        return "psychology-of-money-hindi-thinking-fast-slow-hindi-combo-2-books"
    if str(shopify_id or "") == "CUSTOM-OFF-CAMPUS-COMBO-3-EK":
        return "the-deal-the-mistake-the-score-elle-kennedy-off-campus-combo"
    if str(shopify_id or "") == "CUSTOM-TAIWAN-TRAVELOGUE":
        return "taiwan-travelogue-yang-shuang-zi-international-booker-prize"
    slug = re.sub(r'[^a-z0-9]+', '-', (title or '').lower())
    slug = slug.strip('-')[:55]
    suffix = str(shopify_id or '')[-5:].lower()   # lowercase so URL always matches
    return f"{slug}-{suffix}" if suffix else slug

def clean_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()

# Where product covers are served from.
#
# Default (unset) = the Netlify image-proxy function, which streams every cover
# through our own domain. That hides the supplier CDN but costs ~889 MB/day of
# Netlify bandwidth (~26 GB/month) because Netlify bills every byte it serves,
# cache hit or not.
#
# Set IMAGE_CDN_BASE=https://img.inkandchai.in (Cloudflare R2, zero egress fees)
# to serve them from our own subdomain instead: Netlify image bandwidth drops to
# zero and the supplier stays hidden exactly as before. Object keys are the same
# proxy tokens with a .webp suffix, so ONLY this base URL changes.
#
# Do NOT set this until scripts/upload-images-r2.mjs has finished uploading and
# https://img.inkandchai.in/<token>.webp loads — otherwise every cover 404s.
IMAGE_CDN_BASE = os.environ.get("IMAGE_CDN_BASE", "").rstrip("/")


# Rendered slot sizes, measured in the browser at devicePixelRatio 2:
#   listing/related cards render at 185px  → 400px covers retina
#   product-page hero cover renders at 370px → 800px covers retina
# Serving the 1500px originals was costing ~101 KB per cover; these cost ~37 KB
# and ~81 KB. Cards outnumber the hero ~10:1 per page, so sizing them separately
# matters far more than picking one middle value.
IMG_W_CARD = 400
IMG_W_HERO = 800


def public_image_url(url, w=IMG_W_CARD):
    """Hide third-party CDN fingerprints from public HTML while keeping images loadable.

    `w` is the pixel width to request — it becomes part of the URL, so each size
    is cached independently at the edge.
    """
    url = str(url or "").strip()
    if not url or not url.startswith("http"):
        return url
    token = hashlib.sha256(url.encode("utf-8")).hexdigest()[:24]
    IMAGE_PROXY_MAP[token] = url
    if IMAGE_CDN_BASE:
        return f"{IMAGE_CDN_BASE}/{token}-{w}.webp"
    return f"/.netlify/functions/image-proxy?i={token}&w={w}"

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

# ── Scarcity / urgency: products shown as "Only 4 left" (always pinned, never runs out)
# Add slugs of high-traffic listings here. Admin can also toggle via Products tab.
SCARCITY_SLUGS = {
    # Off Campus combos — highest traffic
    "off-campus-complete-5-book-collection-elle-kennedy",
    "the-deal-the-mistake-the-score-elle-kennedy-off-campus-combo",
    # Top reviewed bundles
    "the-off-campus-series-complete-collection-5-books-by-elle-ke-nnedy",
    "the-deal-the-mistake-the-score-by-elle-kennedy-off-campus-se--3-ek",
    "colleen-hoover-3-book-starter-set-it-ends-with-us-verity-rem-ter-3",
    "wealth-starter-pack-299-psychology-of-money-rich-dad-poor-da-k-299",
    "hindi-motivation-big-4-atomic-habits-rich-dad-poor-dad-shakt-big-4",
    "robert-greene-power-trilogy-48-laws-of-power-laws-of-human-n-ogy-3",
}

# Supplier / placeholder publisher names that must NEVER be shown to customers.
# (Kept in sync with _INTERNAL_PUBLISHER_BLACKLIST below, which is used for authors.)
_HIDDEN_PUBLISHERS = {
    "prakash books", "new kids", "99bookstore", "99bookstores", "99 bookstore",
    "ink and chai", "ink & chai", "inkandchai", "various", "anonymous", "unknown",
    "various authors", "multiple authors", "n/a", "—", "-",
}
def clean_publisher(value):
    """Blank out supplier/placeholder publisher names so the template falls back to
    the store brand instead of exposing where stock is sourced (e.g. 99Bookstore)."""
    p = clean_text(value)
    return "" if p.lower().strip() in _HIDDEN_PUBLISHERS else p

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
    # For CUSTOM- listings with no scraped_at, use today so they sort newest-first
    TODAY_ISO = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")
    effective_ts = scraped or (TODAY_ISO if sid.startswith("CUSTOM-") else "")
    # New-arrival rule: manually-curated additions (CUSTOM-…) OR anything
    # scraped strictly AFTER the bulk import date (bulk was 2026-04-22).
    BULK_IMPORT_DATE = "2026-04-23"
    is_new = 1 if (sid.startswith("CUSTOM-") or (scraped and scraped[:10] >= BULK_IMPORT_DATE)) else 0

    slug = make_slug(b["title"], b.get("shopify_id", ""))
    feed_image_by_slug[slug] = crawlable_image_url(b.get("image_url", ""))
    slim.append({
        "t":    clean_text(b["title"])[:220] if sid in {"CUSTOM-KINGS-OF-SIN-COMPLETE-SET-6-AH", "CUSTOM-HINDI-BESTSELLERS-COMBO-5", "CUSTOM-100M-HINDI-COMBO-2"} else clean_text(b["title"])[:80],
        "a":    clean_publisher(b.get("author", ""))[:50],  # blanks supplier names (e.g. 99Bookstore)
        "p":    price_str,
        "op":   orig_str,
        "img":  public_image_url(b.get("image_url", "")),
        # Hero-sized copy of the same cover for the product page's large slot.
        "img_lg": public_image_url(b.get("image_url", ""), IMG_W_HERO),
        "back_img": public_image_url(b.get("back_image_url", "")),
        "url":  product_path(slug),
        "slug": slug,
        "cat":  clean_text(b.get("category", "")),
        "tab":  tab_for(b.get("category", ""), b),
        "desc": (b.get("description") or "")[:1400],
        "isbn": clean_text(b.get("isbn", "")),
        "pub":  clean_publisher(b.get("publisher", "")),
        "n":    is_new,            # 1 = New Arrival
        "ts":   effective_ts,      # ISO timestamp used for newest-first sort
        "pdf":  b.get("sample_pdf") or "",  # path to sample PDF (read-first-pages preview)
        "pdf_pages": b.get("sample_pdf_pages") or 0,
        # Codex-added review proof fields (kept alongside the new structured reviews)
        "rating": b.get("rating_value") or b.get("rating") or "",
        "review_count": b.get("review_count") or "",
        "order_badge": clean_text(b.get("order_badge", "")),
        "review_image": public_image_url(b.get("review_image") or b.get("review_image_url", "")),
        "review_images": [public_image_url(img) for img in (b.get("review_images") or [])],
        "review_video": b.get("review_video_url") or "",
        # Customer reviews — list of { name, rating (1-5), text } objects.
        # Rendered on both SSR + dynamic product pages, contributes to JSON-LD.
        "reviews": list(b.get("reviews") or []),
        # Description banners — Amazon A+-style wide images shown below description
        "description_banners": [public_image_url(img) for img in (b.get("description_banners") or [])],
        "sku":  b.get("sku", ""),    # Stock-keeping unit — used in cart items and daily report
        # Scarcity flag — shows "Only 4 left" urgency badge (always pinned, never runs out)
        "sc":   1 if (slug in SCARCITY_SLUGS or b.get("scarcity")) else 0,
    })

# Put new arrivals at the very front, newest-first within each group
slim.sort(key=lambda x: x["ts"] or "", reverse=True)   # step 1: newest date first
slim.sort(key=lambda x: x["n"], reverse=True)           # step 2: new-arrivals (n=1) before rest (stable)

books_js = json.dumps(slim, ensure_ascii=False)

# ── Internal-link helpers: which authors and categories have hub pages? ─────
# Pre-computed early so the product page template (further down) can decide
# whether to render "View all books by [Author] →" and "Browse all [Genre] →"
# links. These cross-links flow PageRank to the new hub pages and lift average
# pages-per-session (a ranking signal Google cares about).

from collections import Counter as _Counter

_INTERNAL_PUBLISHER_BLACKLIST = {
    "prakash books", "new kids", "99bookstore", "99bookstores", "99 bookstore",
    "ink and chai", "ink & chai", "inkandchai", "various", "anonymous", "unknown",
    "various authors", "multiple authors", "n/a", "—", "-",
}

_AUTHOR_BOOK_COUNTS = _Counter()
for _b in slim:
    _au = (_b.get("a") or "").strip().lower()
    if not _au: continue
    if _au in _INTERNAL_PUBLISHER_BLACKLIST: continue
    if "," in _au or "&" in _au: continue
    _AUTHOR_BOOK_COUNTS[_au] += 1

def author_hub_url_for(book):
    """Return /author/[slug]/ URL if this book's author has 2+ books on the site."""
    au = (book.get("a") or "").strip()
    if not au: return None
    if au.lower() in _INTERNAL_PUBLISHER_BLACKLIST: return None
    if "," in au or "&" in au: return None
    if _AUTHOR_BOOK_COUNTS.get(au.lower(), 0) < 2: return None
    return f"/author/{slugify(au)[:80]}/"

# Map each book to the most relevant genre landing page (or None).
# Ordering matters: first match wins. More specific buckets before broad ones.
def landing_page_url_for(book):
    cat   = (book.get("cat") or "").lower()
    title = (book.get("t") or "").lower()
    desc  = (book.get("desc") or "").lower()
    a     = (book.get("a") or "").lower()
    is_new = book.get("n") == 1
    hay = cat + " " + title + " " + desc + " " + a

    if "hindi" in cat or "हिंदी" in title:                      return "/best-hindi-books/"
    if "manga" in cat or "manga" in title:                      return "/best-manga-india/"
    if "combo" in cat or any(k in hay for k in ("combo", "box set", "boxset", "complete set", "set of ")):
        return "/book-combos-bundles/"
    if "dark romance" in hay or "ana huang" in a or "twisted" in title or "kings of sin" in title:
        return "/dark-romance-books/"
    if "off-campus" in hay or "off campus" in hay or "elle kennedy" in a or "college romance" in hay:
        return "/college-romance-books/"
    if "thriller" in hay or "mystery" in hay or "freida mcfadden" in a or "psychological" in hay:
        return "/thriller-books-india/"
    if "romance" in cat or "romance" in hay:                    return "/best-romance-books-india/"
    if "self-help" in cat or "self help" in cat or "self help" in hay or "self-help" in hay:
        return "/best-self-help-books-india/"
    if is_new:                                                  return "/new-arrivals-2026/"
    return None

# Pretty label for the landing page link (shown next to category in product page)
_LANDING_LABEL = {
    "/best-romance-books-india/":     "Romance books",
    "/best-self-help-books-india/":   "Self-help books",
    "/best-hindi-books/":             "Hindi books",
    "/dark-romance-books/":           "Dark romance",
    "/best-manga-india/":             "Manga collection",
    "/college-romance-books/":        "College romance",
    "/thriller-books-india/":         "Thriller books",
    "/book-combos-bundles/":          "Book combos",
    "/new-arrivals-2026/":            "New arrivals",
}


# ── Lightweight version for homepage/category/collection pages ───────────────
# The homepage grid never shows descriptions, ISBNs, reviews, PDFs, etc.
# Stripping those fields cuts the embedded JSON from ~2.3MB to ~600KB,
# reducing bandwidth by ~1.5MB per homepage visit (uncompressed).
# We keep desc truncated to 150 chars so inline search still works.
_HOMEPAGE_KEEP = {"t","a","p","op","img","url","slug","cat","tab","n","back_img","order_badge"}
slim_homepage = [
    {k: (v[:150] if k == "desc" else v)
     for k, v in b.items()
     if k in _HOMEPAGE_KEEP or k == "desc"}
    for b in slim
]
books_js_homepage = json.dumps(slim_homepage, ensure_ascii=False)

# ── Write books data as versioned external JS files (avoids re-downloading
#    2+ MB of book data on every page visit; browser caches for 1 year) ──────
_js_dir = Path(__file__).parent / "public" / "js"
_js_dir.mkdir(parents=True, exist_ok=True)

# Bump this when browsers may have cached a previous versioned book-data file
# under the same name. The value is included only in the asset hash, not in the
# payload, so it forces a fresh filename without bloating the catalogue JSON.
_BOOK_DATA_CACHE_BUSTER = "2026-07-09-cant-hurt-search"
_books_full_hash = hashlib.md5((books_js + _BOOK_DATA_CACHE_BUSTER).encode()).hexdigest()[:8]
_books_lite_hash = hashlib.md5((books_js_homepage + _BOOK_DATA_CACHE_BUSTER).encode()).hexdigest()[:8]
_books_full_file = f"books-full-{_books_full_hash}.js"
_books_lite_file = f"books-lite-{_books_lite_hash}.js"

# Clean up old versioned files so public/js/ doesn't grow unboundedly
for _old in _js_dir.glob("books-full-*.js"):
    if _old.name != _books_full_file:
        _old.unlink(missing_ok=True)
for _old in _js_dir.glob("books-lite-*.js"):
    if _old.name != _books_lite_file:
        _old.unlink(missing_ok=True)

(_js_dir / _books_full_file).write_text(f"window.BOOKS_PRELOAD={books_js};", encoding="utf-8")
(_js_dir / _books_lite_file).write_text(f"window.BOOKS_PRELOAD={books_js_homepage};", encoding="utf-8")

BOOKS_FULL_TAG = f'<script src="/js/{_books_full_file}"></script>'
BOOKS_LITE_TAG = f'<script src="/js/{_books_lite_file}"></script>'
# Preload link goes into <head> so the browser starts fetching the books JS
# in parallel with HTML download instead of waiting until the parser hits
# the <script> tag near </body>. Saves 1-3s of "Add to cart does nothing"
# on first paint over slow connections (books-full is ~2.7 MB).
BOOKS_FULL_PRELOAD = f'<link rel="preload" as="script" href="/js/{_books_full_file}"/>'
BOOKS_LITE_PRELOAD = f'<link rel="preload" as="script" href="/js/{_books_lite_file}"/>'

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
<!-- End Meta Pixel Code -->"""
# Two pixels, ONE loader and ONE PageView — deliberately not two pasted copies
# of Meta's snippet. The loader starts with `if(f.fbq)return;`, so a second copy
# no-ops its own loader but still runs `fbq('track','PageView')`, and track
# fires for EVERY initialised pixel. Pasting the second snippet whole would
# therefore have reported two PageViews per visit against 1702042431242274 and
# silently doubled its traffic numbers.
#
# Every other fbq('track'/'trackCustom') on the site — ReadSample, AddToCart,
# Purchase — now reports to both pixels automatically, for the same reason.
# Nothing else needs changing to give the new pixel full conversion data.

# Google Analytics 4.
#
# The site had no GA4 tag at all — only the two AW- Ads tags — which is why the
# GA4-sourced "inkandchai.in (web) purchase" conversion action sat on "Awaiting
# conversions" forever and put the Purchase goal in "Needs attention".
#
# A measurement ID is public — it ships in every page's source — so it lives
# here beside the AW- ids rather than in an env var a build could silently be
# missing. The env var stays as an override for a staging property.
GA4_MEASUREMENT_ID = os.environ.get("GA4_MEASUREMENT_ID", "G-ZPZDFWMDP6").strip()

GA4_TAG = ("""<!-- Google Analytics 4 -->
<script async src="https://www.googletagmanager.com/gtag/js?id=%s"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '%s');
</script>
<!-- End Google Analytics 4 -->""" % (GA4_MEASUREMENT_ID, GA4_MEASUREMENT_ID)) if GA4_MEASUREMENT_ID else ""

GOOGLE_ADS_TAG = """<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=AW-18119332653"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'AW-18119332653');
gtag('config', 'AW-18139908537');
</script>
<!-- End Google tag -->
<!-- Google Merchant Reviews Badge -->
<script id='merchantWidgetScript' src="https://www.gstatic.com/shopping/merchant/merchantwidget.js" defer></script>
<script>
(function(){
  function initMerchantBadge(){
    if(typeof merchantwidget === 'undefined') return;
    merchantwidget.start({
      merchant_id: 5511019734,
      position: 'BOTTOM_RIGHT',
      region: 'IN',
    });
    // Raise the badge above mobile bottom bar after it renders
    setTimeout(function raiseBadge(){
      var found = false;
      document.querySelectorAll('body > div').forEach(function(el){
        var s = el.style;
        if(s.position==='fixed' && (s.right==='20px'||s.right==='16px'||s.right==='0px')){
          s.bottom = '80px';
          found = true;
        }
      });
      if(!found) setTimeout(raiseBadge, 500);
    }, 800);
  }
  var s = document.getElementById('merchantWidgetScript');
  if(s) s.addEventListener('load', initMerchantBadge);
})();
</script>
<!-- End Google Merchant Reviews Badge -->"""

# ── Premium refinement layer ─────────────────────────────────────────────────
# Injected last in <head> so it refines (not replaces) each page's styles. Adds
# depth + smooth motion to buttons, crisper type, and tasteful hover states.
# Works in both dark and light themes (gold accents are gold in both).
PREMIUM_REFINEMENT_CSS = """<style id="premium-refinement-layer">
/* Typography system — bookshop-grade.
   --font-display: Fraunces — for hero titles, book names, section headings.
                   Variable opsz means a single file works for huge & small.
   --font-serif:   Lora — for long-form reading (descriptions, articles).
                   Cormorant kept as inner fallback in case any inline rule
                   still names it directly.
   --font-sans:    Inter — UI labels, buttons, captions. Crisper than Source
                   Sans 3 at small sizes. */
:root{
  --font-display:'Fraunces','Cormorant Garamond','Noto Serif Devanagari',Georgia,'Times New Roman',serif;
  --font-serif:'Lora','Cormorant Garamond','Noto Serif Devanagari',Georgia,'Times New Roman',serif;
  --font-sans:'Inter','Noto Sans Devanagari',system-ui,-apple-system,'Segoe UI',sans-serif;
}
body{
  font-family:var(--font-sans);
  font-size:15px;
  line-height:1.65;
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
  text-rendering:optimizeLegibility;
  font-feature-settings:"kern" 1, "liga" 1, "calt" 1;
}
h1,h2,h3,.section-title,.hero-title,.coll-name,.book-name,.prod-title,.ah-title,.editorial-quote,.nav-logo{
  font-family:var(--font-display);
  font-optical-sizing:auto;
  /* Slight optical-size hint where Fraunces variable supports it. */
  font-variation-settings:"opsz" 72;
}
h1,h2,h3,.section-title,.hero-title,.coll-name{ letter-spacing:-.005em; }
.hero-title,.section-title{ font-weight:600; }
/* Long-form reading surfaces feel like a book page. */
.prod-desc,.prod-description,.description,.article-body,.about-copy,.editorial-quote,.book-summary{
  font-family:var(--font-serif);
  font-size:1.02rem;
  line-height:1.75;
}
/* UI labels: less stretched tracking, slightly larger for legibility */
.nav-links a,.btn-nav,.btn-primary,.btn-ghost,.tab,.btn-add,.btn-add-card,.btn-checkout,
.btn-load-more,.btn-subscribe,.promo-banner,.mob-nav a,.mob-nav button,.nav-dropdown a,
.btn-cart,.btn-cod,.pbb-cart,.pbb-buy,.fbt-cta,.back,.nav-back,.crumb{
  letter-spacing:.1em !important;
}
.nav-links a{ font-size:.82rem !important; color:var(--cream) !important; font-weight:500; }
html[data-theme="light"] .nav-links a{ color:#3a2e18 !important; }
.btn-nav,.btn-primary,.tab,.btn-cart,.btn-cod{ font-size:.72rem !important; }
.btn-add-card,.shelf-card-btn{ font-size:.6rem !important; min-height:2.2rem; }
.hero-sub,.subtitle,.intro,.body-copy{ font-size:.875rem !important; line-height:1.75 !important; letter-spacing:.015em !important; }
.book-name{ font-size:1.08rem !important; line-height:1.28 !important; }
.book-author,.book-meta{ font-size:.78rem !important; letter-spacing:.04em !important; }
/* Brighter muted text for contrast on dark backgrounds */
html:not([data-theme="light"]) body{ --cream-dim:#b5a595; }

/* Solid gold buttons — metallic gradient, depth, springy hover lift */
.btn-add,.btn-pay,.primary,.btn-checkout{
  background-image:linear-gradient(135deg,#eccd80 0%,#cda94f 46%,#b9832f 100%) !important;
  color:#1a1209 !important; border:none !important;
  box-shadow:0 6px 18px rgba(138,106,31,.28), inset 0 1px 0 rgba(255,255,255,.38) !important;
  transition:transform .28s cubic-bezier(.34,1.56,.64,1), box-shadow .28s ease, filter .28s ease !important;
}
.btn-add:hover,.btn-pay:hover,.primary:hover,.btn-checkout:hover{
  transform:translateY(-2px) !important; filter:brightness(1.04) !important;
  box-shadow:0 12px 28px rgba(201,168,76,.42), inset 0 1px 0 rgba(255,255,255,.5) !important;
}
.btn-add:active,.btn-pay:active,.primary:active,.btn-checkout:active{
  transform:translateY(0) scale(.99) !important; box-shadow:0 4px 12px rgba(138,106,31,.3) !important;
}

/* Outline buttons (card "Add to Cart", COD, CTA) — refined hover fill */
.btn-add-card,.btn-cod,.cta,.shelf-card-btn,.btn-partial{
  transition:background .25s ease,color .25s ease,border-color .25s ease,box-shadow .25s ease,transform .15s ease !important;
}
.btn-add-card:hover,.btn-cod:hover,.cta:hover,.shelf-card-btn:hover{
  background-image:linear-gradient(135deg,#eccd80,#c9a84c) !important; color:#1a1209 !important;
  border-color:transparent !important; box-shadow:0 6px 16px rgba(138,106,31,.24) !important;
}
.btn-add-card:active,.btn-cod:active,.cta:active,.shelf-card-btn:active{ transform:scale(.98) !important; }

/* Inputs: softer premium focus ring in brand gold */
input:focus,textarea:focus,select:focus{ outline:none !important; box-shadow:0 0 0 2px rgba(201,168,76,.45) !important; }
</style>"""

def with_meta_pixel(html: str) -> str:
    html = inject_font_links(html)
    tags = []
    if "1702042431242274" not in html:
        tags.append(META_PIXEL_CODE)
    if "googletagmanager.com/gtag/js?id=AW-18119332653" not in html:
        tags.append(GOOGLE_ADS_TAG)
    if "premium-refinement-layer" not in html:
        tags.append(PREMIUM_REFINEMENT_CSS)
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
    # A few page-level refinement rules mention `.reader-activity-toast`
    # (for example, border-radius or mobile bottom spacing). That does not mean
    # the component's base fixed-position stylesheet is present. Use the
    # component marker so a partial selector cannot suppress the real CSS.
    if "/* Animated reader activity notification */" not in html:
        html = html.replace("</style>", READER_ACTIVITY_CSS + "\n</style>", 1)
    if "readerActivityToast" not in html:
        html = html.replace("</body>", READER_ACTIVITY_JS.replace("RECENT_ORDER_ACTIVITY_PLACEHOLDER", recent_order_activity_js) + "\n</body>", 1)
    html = with_page_loader(html)
    return html


# ── Book-themed page-transition loader ────────────────────────────────────────
# An open book with flipping pages, shown the moment a user clicks an internal
# link (i.e. during the real network wait) and hidden again via pageshow so the
# back/forward cache never leaves a stale overlay. Pure CSS animation, ~2KB.
PAGE_LOADER_CSS = """
/* Book page-transition loader */
#iacPageLoader{position:fixed;inset:0;z-index:100000;background:rgba(13,11,8,0.93);backdrop-filter:blur(6px);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.3rem;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .28s ease,visibility .28s ease}
html[data-theme="light"] #iacPageLoader{background:rgba(250,247,242,0.93)}
#iacPageLoader.show{opacity:1;visibility:visible;pointer-events:all}
.iac-bookload{width:88px;height:60px;position:relative;perspective:340px}
.iac-bookload-base{position:absolute;inset:0;border:2px solid #c9a84c;border-radius:4px 8px 8px 4px;box-shadow:0 14px 38px rgba(0,0,0,.45)}
html[data-theme="light"] .iac-bookload-base{border-color:#8a6a1f;box-shadow:0 14px 38px rgba(70,52,24,.18)}
.iac-bookload-base::before{content:'';position:absolute;left:50%;top:4px;bottom:4px;width:2px;margin-left:-1px;background:rgba(201,168,76,.45)}
.iac-bookload-page{position:absolute;top:7px;bottom:7px;left:50%;width:calc(50% - 9px);background:linear-gradient(105deg,#f0e8d8 0%,#dccdaa 85%);border-radius:0 3px 3px 0;transform-origin:left center;animation:iacBookFlip 1.5s cubic-bezier(.45,.05,.55,.95) infinite;backface-visibility:visible}
.iac-bookload-page:nth-child(2){animation-delay:.18s;opacity:.85}
.iac-bookload-page:nth-child(3){animation-delay:.36s;opacity:.7}
@keyframes iacBookFlip{0%{transform:rotateY(0)}80%,100%{transform:rotateY(-180deg)}}
.iac-bookload-text{font-family:'Cormorant Garamond',serif;font-style:italic;font-size:1.05rem;color:#c9a84c;letter-spacing:.06em;animation:iacBookPulse 1.5s ease-in-out infinite}
html[data-theme="light"] .iac-bookload-text{color:#8a6a1f}
@keyframes iacBookPulse{0%,100%{opacity:.55}50%{opacity:1}}
@media(prefers-reduced-motion:reduce){.iac-bookload-page{animation:none;transform:rotateY(-30deg)}.iac-bookload-text{animation:none}}
"""

PAGE_LOADER_JS = """
<div id="iacPageLoader" aria-hidden="true">
  <div class="iac-bookload">
    <div class="iac-bookload-base"></div>
    <div class="iac-bookload-page"></div>
    <div class="iac-bookload-page"></div>
    <div class="iac-bookload-page"></div>
  </div>
  <div class="iac-bookload-text" id="iacPageLoaderText">Turning the page&hellip;</div>
</div>
<script>
(function(){
  var loader = document.getElementById('iacPageLoader');
  if (!loader) return;
  var MESSAGES = ['Turning the page\\u2026','Fetching your next read\\u2026','Dusting off the shelf\\u2026','Opening chapter one\\u2026'];
  function show(msg){
    var t = document.getElementById('iacPageLoaderText');
    if (t) t.textContent = msg || MESSAGES[Math.floor(Math.random()*MESSAGES.length)];
    loader.classList.add('show');
  }
  function hide(){ loader.classList.remove('show'); }
  // Hide when arriving on a page — covers normal loads AND bfcache back/forward
  window.addEventListener('pageshow', hide);
  // Safety: never let the overlay stick longer than 8s (e.g. download links)
  var failsafe;
  // Show on internal link navigation — the actual wait the user feels
  document.addEventListener('click', function(e){
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#') return;
    if (/^(javascript:|mailto:|tel:|whatsapp:)/i.test(href)) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download')) return;
    var url;
    try { url = new URL(href, location.href); } catch(err){ return; }
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
    show(url.pathname.indexOf('/checkout') === 0 ? 'Preparing your checkout\\u2026' : null);
    clearTimeout(failsafe);
    failsafe = setTimeout(hide, 8000);
  }, true);
})();
</script>
"""

def with_page_loader(html: str) -> str:
    html = inject_font_links(html)
    if "iacPageLoader" in html:
        return html
    html = html.replace("</style>", PAGE_LOADER_CSS + "\n</style>", 1)
    html = html.replace("</body>", PAGE_LOADER_JS + "\n</body>", 1)
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
<!-- Google site verification (Merchant Center / Search Console account 5782474419) -->
<meta name="google-site-verification" content="SSzlQkcCmKNDoQOSHrL2agMM2FGlDuvgHG9hNVIRbLg" />
<meta name="theme-color" content="#0d0b08" media="(prefers-color-scheme: dark)" />
<meta name="theme-color" content="#faf7f2" media="(prefers-color-scheme: light)" />
<meta name="geo.region" content="IN" />
<meta name="geo.placename" content="Delhi" />
<meta name="language" content="English, Hindi" />
<link rel="canonical" href="https://inkandchai.in/" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="dns-prefetch" href="https://inkandchai.in" />
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
    "streetAddress": "2379 Kucha Mir Hashim, Turkman Gate",
    "addressLocality": "Delhi",
    "addressRegion": "Delhi",
    "postalCode": "110006",
    "addressCountry": "IN"
  },
  "contactPoint": {
    "@type": "ContactPoint",
    "telephone": "+91-7678400508",
    "contactType": "customer support",
    "email": "support@inkandchai.in",
    "availableLanguage": ["English", "Hindi"]
  },
  "sameAs": ["https://wa.me/917678400508"],
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
  // Apply saved theme BEFORE paint; dark is the default storefront theme.
  (function(){ var d = document.documentElement; try { if (localStorage.getItem('iac_theme') === 'dark') d.removeAttribute('data-theme'); else d.setAttribute('data-theme','light'); } catch(e){ d.setAttribute('data-theme','light'); /* light default */ } })();
  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme');
    var next = cur === 'light' ? 'dark' : 'light';
    if (next === 'light') document.documentElement.setAttribute('data-theme', next);
    else                  document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('iac_theme', next); } catch(e){}
  }
</script>
<link href="FONT_GOOGLE_URL_PLACEHOLDER" rel="stylesheet" />
<style>
  :root {
    --bg: #0d0b08; --bg2: #141210; --bg3: #1c1916;
    --gold: #c9a84c; --gold-light: #e8c97a; --gold-dim: #7a6330;
    --cream: #f0e8d8; --cream-dim: #b5a595; --white: #faf7f2;
    --font-display: 'Fraunces', 'Cormorant Garamond', 'Noto Serif Devanagari', Georgia, serif;
    --font-serif: 'Lora', 'Cormorant Garamond', 'Noto Serif Devanagari', Georgia, serif;
    --font-sans: 'Inter', 'Noto Sans Devanagari', system-ui, sans-serif;
    --border: rgba(201,168,76,0.18);
    --shadow-color: rgba(0,0,0,0.6);
  }
  /* LIGHT MODE */
  html[data-theme="light"] {
    --bg: #faf7f2; --bg2: #f3ece0; --bg3: #ffffff;
    --gold: #7a5a12; --gold-light: #5f4610; --gold-dim: #6a4f10;
    --cream: #241c14; --cream-dim: #4e4032; --white: #0d0b08;
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
  /* .slide-campus paints its own dark panel, so it keeps pale ink in both
     themes. Its own rules are out-specified by the light overrides above
     (0,2,1 beats 0,2,0), so they have to be restated at light specificity. */
  html[data-theme="light"] .slide-campus .hero-title { color:#f0ebff; }
  html[data-theme="light"] .slide-campus .hero-sub { color:rgba(200,190,240,0.78); }
  html[data-theme="light"] .slide-campus .btn-ghost { color:rgba(200,190,240,0.82); }
  html[data-theme="light"] .slide-campus .stat-label { color:rgba(200,190,240,0.75); }
  html[data-theme="light"] .coll-desc { color: #4a3a25; }
  html[data-theme="light"] .footer { background: #1a1410; color: #e8dcc4; }
  html[data-theme="light"] .editorial-quote { color: #1a1208; }
  /* .editorial-visual is another dark gradient panel; the pull-quote and its
     attribution sit on top of it and keep pale ink in both themes. */
  html[data-theme="light"] .editorial-visual .editorial-quote { color:#f4ecdc; }
  html[data-theme="light"] .editorial-visual .editorial-attr { color:#d9bb6b; }
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
  body { background: var(--bg); color: var(--cream); font-family: var(--font-sans); font-weight: 400; overflow-x: hidden; min-height: 100vh; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; font-size: 15px; line-height: 1.65; }
  /* Hard fallback: if anything goes wrong with vars, content still readable */
  html:not([data-theme="light"]) body { background: #0d0b08; color: #f0e8d8; }
  html[data-theme="light"] body { background: #faf7f2; color: #2a2018; }

  body::before {
    content: ''; position: fixed; inset: 0;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
    pointer-events: none; z-index: 999; opacity: 0.4;
  }

  /* NAV */
  nav { position: static; z-index: 100; display: flex; flex-wrap: wrap; row-gap: 0.7rem; align-items: center; justify-content: space-between; padding: 1.4rem 4rem; background: linear-gradient(to bottom, rgba(13,11,8,0.97) 0%, transparent 100%); border-bottom: 1px solid var(--border); backdrop-filter: blur(12px); }
  .nav-logo { display: inline-flex; align-items: center; gap: 0.5rem; font-family: 'Cormorant Garamond', serif; font-size: 1.5rem; font-weight: 600; letter-spacing: 0.08em; color: var(--gold); text-decoration: none; }
  .nav-logo .logo-img { height: 38px; width: auto; display: block; }
  .nav-logo .logo-light { display: none; }
  html[data-theme="light"] .nav-logo .logo-dark  { display: none; }
  html[data-theme="light"] .nav-logo .logo-light { display: block; }
  @media(max-width:780px) { .nav-logo .logo-img { height: 32px; } }
  /* overflow MUST stay visible here — the hover dropdown menus (.nav-dropdown)
     are absolutely positioned inside these <li>s and get clipped if the row
     scrolls/clips. flex:1 1 0 keeps the links to their leftover row-1 space so
     the account icons stay on row 1 without needing overflow. */
  .nav-links { display: flex; gap: 2rem; list-style: none; flex: 1 1 0; min-width: 0; justify-content: center; overflow: visible; flex-wrap: wrap; row-gap: 0.4rem; }
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
  /* Touch/mobile: hover doesn't exist, so a tap toggles .open on the menu (JS).
     display:grid overrides the mobile `.nav-dropdown{display:none}` (this
     3-class selector outranks it) so the tapped menu actually renders. */
  .nav-dropdown-menu.open .nav-dropdown { display: grid; opacity: 1; visibility: visible; pointer-events: auto; transform: translateX(-50%) translateY(0); }
  .nav-dropdown a { display: flex; justify-content: space-between; align-items: center; gap: 0.8rem; padding: 0.55rem 0.65rem; border: 1px solid transparent; font-size: 0.58rem; letter-spacing: 0.12em; line-height: 1.35; white-space: normal; }
  .nav-dropdown a:hover { border-color: var(--border); background: rgba(201,168,76,0.08); }
  .nav-cat-count { flex: 0 0 auto; color: var(--gold-dim); font-size: 0.72em; letter-spacing: 0.04em; text-transform: none; }
  .nav-actions { display: flex; gap: 1.4rem; align-items: center; }
  .nav-icon { color: var(--cream-dim); cursor: pointer; transition: color 0.3s; font-size: 1rem; }
  .nav-icon:hover { color: var(--gold); }
  .nav-search-btn { color: var(--cream); cursor: pointer; transition: color 0.3s, border-color 0.3s, background 0.3s; font: inherit; background: rgba(201,168,76,0.08); border: 1px solid var(--border); border-radius: var(--pill); padding: 0.5rem 0.95rem; gap: 0.4rem; display: inline-flex; align-items: center; justify-content: center; font-size: 1.05rem; line-height: 1; }
  .nav-search-btn:hover { color: var(--gold); border-color: var(--gold); background: rgba(201,168,76,0.14); }
  /* Search sits on its own full-width SECOND row (desktop) instead of being
     squeezed into the first row between the links and the icons. flex-basis
     100% forces it to wrap below; max-width + margin auto keep it a tidy,
     centred pill rather than spanning the whole nav width. order:5 pushes it
     after logo/links/actions so those stay on row 1. */
  /* Zero-height full-width flex item: forces a line break so the search lands
     on its own visible second row while logo+links+icons stay on row 1. */
  .nav-break { order: 4; flex: 0 0 100%; height: 0; margin: 0; padding: 0; }
  .nav-search { order: 5; display: flex; align-items: center; gap: 0.3rem; background: rgba(201,168,76,0.08); border: 1px solid var(--border); border-radius: var(--pill); padding: 0.3rem 0.3rem 0.3rem 0.9rem; flex: 0 1 auto; width: 560px; max-width: 100%; min-width: 0; margin: 0.1rem auto 0; position: relative; }
  .nav-search input { flex: 1; background: transparent; border: 0; color: var(--cream); font: inherit; font-size: 0.78rem; outline: none; min-width: 0; }
  .nav-search input::placeholder { color: var(--cream-dim); }
  .nav-search button { padding: 0.35rem 0.55rem; border-radius: var(--pill); border: 1px solid var(--border); background: transparent; color: var(--gold); cursor: pointer; font-size: 0.9rem; line-height: 1; min-height: 0; }
  .nav-search button:hover { border-color: var(--gold); }
  .nav-kbd-hint { margin-left: 0.2rem; opacity: 0.6; font-size: 0.7rem; }
  @media (hover: none), (max-width: 780px) { .nav-kbd-hint { display: none; } }
  .nav-search-label { display: inline; font-size: 0.66rem; letter-spacing: 0.16em; text-transform: uppercase; font-family: 'Inter', sans-serif; }
  .btn-nav { font-family: 'Inter', sans-serif; font-size: 0.62rem; letter-spacing: 0.22em; text-transform: uppercase; padding: 0.55rem 1.4rem; border: 1px solid var(--gold-dim); color: var(--gold); background: transparent; cursor: pointer; transition: all 0.3s; text-decoration: none; }
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
  .btn-primary { font-family: 'Inter', sans-serif; font-size: 0.65rem; letter-spacing: 0.25em; text-transform: uppercase; padding: 1rem 2.4rem; background: var(--gold); color: var(--bg); border: none; cursor: pointer; font-weight: 500; transition: all 0.3s; text-decoration: none; display: inline-block; }
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
  .hero-cover-card { position:relative; display:block; aspect-ratio:2/3; background:var(--bg2); border:1px solid rgba(201,168,76,0.28); box-shadow:0 18px 42px rgba(0,0,0,0.5); overflow:hidden; transition:transform 0.25s,border-color 0.25s,box-shadow 0.25s; text-decoration:none; touch-action:manipulation; }
  .hero-cover-card:nth-child(2),.hero-cover-card:nth-child(5){transform:translateY(2rem)}
  .hero-cover-card:nth-child(4),.hero-cover-card:nth-child(7){transform:translateY(-1.2rem)}
  @media(hover:hover) {
    .hero-cover-card:hover{transform:translateY(-0.35rem) scale(1.02);border-color:rgba(201,168,76,0.7);box-shadow:0 24px 55px rgba(0,0,0,0.65)}
    .hero-cover-card:nth-child(2):hover,.hero-cover-card:nth-child(5):hover{transform:translateY(1.65rem) scale(1.02)}
    .hero-cover-card:nth-child(4):hover,.hero-cover-card:nth-child(7):hover{transform:translateY(-1.55rem) scale(1.02)}
    .hero-cover-card:hover::after { opacity:1; transform:translateY(0); }
  }
  .hero-cover-card.featured { grid-row:span 2; }
  .hero-cover-card img { width:100%; height:100%; object-fit:cover; display:block; }
  .hero-cover-card::after { content:attr(data-label); position:absolute; left:0; right:0; bottom:0; padding:1.6rem 0.7rem 0.65rem; background:linear-gradient(to top,rgba(0,0,0,0.88),transparent); color:var(--cream); font-size:0.54rem; letter-spacing:0.16em; text-transform:uppercase; line-height:1.35; opacity:0; transform:translateY(8px); transition:opacity 0.25s,transform 0.25s; pointer-events:none; }
  .hero-note { position:absolute; z-index:3; right:5rem; bottom:6.2rem; max-width:280px; padding:1rem 1.15rem; background:rgba(13,11,8,0.78); border:1px solid rgba(201,168,76,0.28); backdrop-filter:blur(10px); color:var(--cream-dim); font-size:0.64rem; letter-spacing:0.08em; line-height:1.7; text-transform:uppercase; }
  .hero-note strong { color:var(--gold); font-weight:500; }

  /* PROMO CAROUSEL WRAPPER */
  .promo-carousel { position:relative; overflow:hidden; }
  .promo-slide { position:absolute; inset:0; opacity:0; pointer-events:none; transition:opacity 0.75s ease; z-index:0; min-height:100vh; }
  .promo-slide.active { opacity:1; pointer-events:auto; z-index:1; position:relative; }
  /* Image-only slide overrides */
  .promo-slide.slide-sale { min-height:unset; }
  /* Dots */
  .promo-dots { position:absolute; bottom:1.5rem; left:50%; transform:translateX(-50%); display:flex; gap:0.6rem; z-index:10; }
  .promo-dot { width:8px; height:8px; border-radius:50%; border:1px solid rgba(201,168,76,0.6); background:transparent; cursor:pointer; transition:all 0.3s; padding:0; }
  .promo-dot.active { background:var(--gold); border-color:var(--gold); transform:scale(1.2); }
  /* Arrows */
  .promo-arrow { position:absolute; top:50%; transform:translateY(-50%); z-index:10; background:rgba(13,11,8,0.55); color:var(--gold); width:44px; height:44px; border-radius:50%; border:1px solid rgba(201,168,76,0.4); cursor:pointer; font-size:1.2rem; display:flex; align-items:center; justify-content:center; transition:all 0.25s; backdrop-filter:blur(8px); }
  .promo-arrow:hover { background:var(--gold); color:var(--bg); }
  .promo-arrow.prev { left:1.5rem; }
  .promo-arrow.next { right:1.5rem; }
  @media(max-width:900px) { .promo-arrow { display:none; } .promo-dots { bottom:1.2rem; } }

  /* SLIDE 1 — SUMMER SALE (full banner image) */
  .slide-sale { background:#fef3e8; display:flex!important; align-items:stretch; justify-content:center; min-height:unset!important; }
  .sale-banner-link { display:flex; align-items:center; justify-content:center; width:100%; position:relative; text-decoration:none; }
  .sale-banner-link picture { display:block; width:100%; }
  .sale-banner-link img { width:100%; display:block; object-fit:contain; }
  .sale-banner-code-badge { position:absolute; bottom:1.5rem; left:50%; transform:translateX(-50%); background:rgba(200,70,0,0.9); color:#fff; font-family:'Inter',sans-serif; font-size:0.7rem; font-weight:700; letter-spacing:0.2em; text-transform:uppercase; padding:0.6rem 1.4rem; cursor:pointer; white-space:nowrap; border:2px solid rgba(255,255,255,0.5); transition:background 0.2s; z-index:3; }
  .sale-banner-code-badge:hover { background:rgba(200,70,0,1); }

  /* SLIDE 2 — OFF CAMPUS */
  .slide-campus { background:linear-gradient(135deg,#0d0a1a 0%,#1a1230 50%,#0a0d1a 100%); }
  .slide-campus .hero-eyebrow { color:rgba(180,160,255,0.85); }
  .slide-campus .hero-title { color:#f0ebff; }
  .slide-campus .hero-title em { color:#c9a84c; }
  .slide-campus .hero-sub { color:rgba(200,190,240,0.78); }
  .slide-campus .hero-stats { border-color:rgba(180,160,255,0.2); }
  .slide-campus .stat-num { color:#c9a84c; }
  .slide-campus .stat-label { color:rgba(200,190,240,0.65); }
  .campus-img-wrap { width:min(420px,90%); position:relative; z-index:2; }
  .campus-img-wrap img { width:100%; display:block; filter:drop-shadow(0 24px 48px rgba(0,0,0,0.6)); }
  .campus-price-badge { position:absolute; top:-1rem; right:-1rem; background:var(--gold); color:var(--bg); font-family:'Inter',sans-serif; font-size:1.1rem; font-weight:800; width:72px; height:72px; border-radius:50%; display:flex; flex-direction:column; align-items:center; justify-content:center; line-height:1.1; box-shadow:0 8px 24px rgba(201,168,76,0.4); }
  .campus-price-badge span { font-size:0.5rem; letter-spacing:0.1em; font-weight:500; }

  /* ── MOBILE: carousel collapses to compact cards ── */
  @media(max-width:900px) {
    /* Non-image hero slides: single column, compact height */
    .promo-carousel { min-height:auto; }
    .promo-slide { min-height:unset; }
    .promo-slide:not(.active) { display:none; position:absolute; }

    /* Collapse hero grid to single column */
    .promo-carousel .hero {
      display:flex; flex-direction:column;
      min-height:unset; padding:0;
    }
    /* On mobile show the image first (top), text below */
    .promo-carousel .hero-right {
      order:1; padding:1.5rem 1rem 0.5rem;
      justify-content:center;
    }
    .promo-carousel .hero-left {
      order:2; padding:1.8rem 1.2rem 4rem;
    }
    /* Tighten up text for small screens */
    .promo-carousel .hero-title { font-size:clamp(2rem,7vw,3rem); margin-bottom:1rem; }
    .promo-carousel .hero-sub { font-size:0.78rem; margin-bottom:1.5rem; max-width:100%; }
    .promo-carousel .hero-stats { gap:1.5rem; margin-top:1.5rem; padding-top:1.2rem; }
    .promo-carousel .hero-ctas { flex-direction:column; gap:0.8rem; align-items:flex-start; }
    .promo-carousel .hero-note { display:none; }

    /* Cover wall: smaller grid on mobile */
    .promo-carousel .hero-cover-wall {
      grid-template-columns:repeat(4,minmax(62px,1fr)); gap:0.55rem;
      transform:rotate(1deg); width:100%;
    }
    .promo-carousel .hero-right::before { display:none; }

    /* Hide long descriptions on mobile — keep slide compact */
    .promo-carousel .hero-sub-desktop { display:none; }

    /* Off Campus image */
    .campus-img-wrap { width:min(240px,70vw); margin:0 auto; }
    .campus-price-badge { width:58px; height:58px; font-size:0.9rem; top:-0.6rem; right:-0.6rem; }

    /* Summer sale banner: full-width, natural aspect ratio */
    .slide-sale { min-height:unset!important; }
    .sale-banner-link img { width:100%; object-fit:contain; max-height:none; }
    .sale-banner-code-badge { font-size:0.58rem; padding:0.45rem 0.9rem; bottom:0.6rem; }

    /* Dots: inside the slide, above bottom nav */
    .promo-dots { position:relative; bottom:auto; left:auto; transform:none; justify-content:center; padding:0.8rem 0 0.4rem; background:var(--bg); }
  }
  @media(max-width:480px) {
    .promo-carousel .hero-title { font-size:clamp(1.8rem,6.5vw,2.4rem); }
    .promo-carousel .hero-cover-wall { grid-template-columns:repeat(4,minmax(52px,1fr)); gap:0.4rem; }
  }

  /* MARQUEE */
  .marquee-bar { background: var(--gold); padding: 0.75rem 0; overflow: hidden; white-space: nowrap; }
  .marquee-track { display: inline-flex; animation: marquee 30s linear infinite; }
  .marquee-item { font-size: 0.6rem; letter-spacing: 0.3em; text-transform: uppercase; color: #f4ecdc; font-weight: 500; padding: 0 2.5rem; }
  /* Was a hardcoded dark ink, which only worked against the pale gold bar of
     the dark theme. Inheriting the item colour keeps it subordinate to the
     text in both themes instead of vanishing into the bar in light. */
  .marquee-dot { color: inherit; opacity: 0.62; }
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
  /* Rotating-feature crossfade */
  .kog-content, .kog-book-wrap, .kog-price { transition: opacity 0.5s ease; }
  .kog-banner.kog-fading .kog-content,
  .kog-banner.kog-fading .kog-book-wrap,
  .kog-banner.kog-fading .kog-price { opacity: 0; }
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
  .kog-store-label { font-family:'Cinzel',serif; font-size:clamp(7px,0.65vw,10px); letter-spacing:5px; color:rgba(212,175,55,0.85); text-transform:uppercase; margin-bottom:clamp(8px,1.2vw,16px); animation:kogFadeUp 0.8s ease both; }
  .kog-series { display:inline-flex; align-items:center; gap:8px; margin-bottom:clamp(6px,1vw,12px); animation:kogFadeUp 0.9s ease both; }
  .kog-series-line { width:20px; height:1px; background:rgba(212,175,55,0.5); }
  .kog-series-text { font-family:'Cormorant Garamond',serif; font-size:clamp(8px,0.85vw,11px); letter-spacing:3px; color:rgba(212,175,55,0.88); text-transform:uppercase; font-style:italic; }
  .kog-title { font-family:'Cinzel',serif; font-weight:900; font-size:clamp(20px,4vw,44px); line-height:1; color:transparent; background:linear-gradient(180deg,#f0d060 0%,#c9a227 40%,#a07818 100%); -webkit-background-clip:text; background-clip:text; letter-spacing:2px; margin-bottom:6px; animation:kogFadeUp 1s ease both; }
  .kog-subtitle { font-family:'Cormorant Garamond',serif; font-size:clamp(8px,0.95vw,13px); letter-spacing:4px; color:rgba(212,175,55,0.82); text-transform:uppercase; margin-bottom:clamp(8px,1.4vw,18px); animation:kogFadeUp 1.1s ease both; }
  .kog-divider { width:50px; height:1px; background:linear-gradient(90deg,rgba(212,175,55,0.6),transparent); margin-bottom:clamp(8px,1.2vw,16px); animation:kogFadeUp 1.2s ease both; }
  .kog-author { font-family:'Cormorant Garamond',serif; font-size:clamp(9px,1vw,15px); letter-spacing:2px; color:rgba(255,255,255,0.5); margin-bottom:2px; animation:kogFadeUp 1.3s ease both; }
  .kog-author strong { color:rgba(255,255,255,0.82); font-weight:600; }
  .kog-bestseller { font-family:'Cormorant Garamond',serif; font-size:clamp(7px,0.8vw,11px); letter-spacing:3px; color:rgba(212,175,55,0.82); font-style:italic; text-transform:uppercase; margin-bottom:clamp(10px,1.6vw,22px); animation:kogFadeUp 1.35s ease both; }
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
  .kog-crown { color:rgba(212,175,55,0.9); position:absolute; top:clamp(10px,2vw,28px); left:clamp(16px,3vw,50px); font-size:clamp(12px,1.5vw,18px); opacity:0.4; z-index:2; animation:kogFadeUp 0.7s ease both; }
  /* Mobile adjustments */
  @media(max-width:600px){
    .kog-banner { aspect-ratio:unset; min-height:unset; display:flex; flex-direction:row; align-items:center; padding:0; }
    .kog-content { position:static; width:auto; flex:1; padding:16px 14px 16px 16px; }
    .kog-store-label { display:none; }
    .kog-series { margin-bottom:4px; }
    .kog-title { font-size:clamp(18px,5.5vw,26px); margin-bottom:4px; }
    .kog-subtitle { font-size:9px; margin-bottom:8px; letter-spacing:2px; }
    .kog-divider { margin-bottom:8px; }
    .kog-author { font-size:10px; }
    .kog-bestseller { font-size:8px; margin-bottom:12px; }
    .kog-cta { font-size:8px; padding:8px 14px; letter-spacing:2px; }
    .kog-book-wrap {
      position:static; transform:none; animation:none;
      width:38%; flex-shrink:0; padding:12px 12px 12px 0;
      filter:drop-shadow(-6px 8px 16px rgba(0,0,0,0.7));
    }
    .kog-price { position:static; margin:8px 0 0; display:inline-block; font-size:12px; padding:4px 12px; }
    .kog-spark-1,.kog-spark-2,.kog-spark-3,.kog-crown,.kog-banner::after { display:none; }
    /* Re-order: content left, book right */
    .kog-book-wrap { order:2; }
    .kog-content { order:1; }
  }

  /* SECTIONS SHARED */
  section { padding: 7rem 6rem; }
  .section-label { font-size: 0.6rem; letter-spacing: 0.35em; text-transform: uppercase; color: var(--gold); margin-bottom: 1rem; display: flex; align-items: center; gap: 1rem; }
  .section-label::before { content: ''; display: inline-block; width: 30px; height: 1px; background: var(--gold); }
  .section-title { font-family: 'Cormorant Garamond', serif; font-size: clamp(2rem, 4vw, 3.2rem); font-weight: 500; color: var(--white); line-height: 1.12; margin-bottom: 1rem; letter-spacing: -0.01em; }
  .section-title em { font-style: italic; color: var(--gold-light); }

  /* ── SUMMER SALE BANNER ──────────────────────────────────────────── */
  .summer-sale-banner { background: linear-gradient(115deg,#ff9933 0 30%,#fff8e8 30% 68%,#138808 68% 100%); color:#0b2f63; border-bottom:3px solid #138808; padding:2.8rem 6rem; position:relative; overflow:hidden; }
  .summer-sale-banner::before { content:''; position:absolute; inset:0; background:url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.03'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E"); }
  .summer-sale-inner { display:flex; align-items:center; justify-content:space-between; gap:2rem; position:relative; }
  .summer-sale-left { flex:1; }
  .sale-eyebrow { font-size:0.52rem; letter-spacing:0.3em; text-transform:uppercase; color:#0b2f63; margin-bottom:0.5rem; font-weight:700; }
  .sale-headline { font-family:'Cormorant Garamond',serif; font-size:clamp(1.7rem,3.5vw,2.6rem); font-weight:600; color:#0b2f63; line-height:1.1; margin-bottom:0.55rem; }
  .sale-headline em { font-style:italic; color:#0b2f63; }
  .sale-code-row { display:flex; align-items:center; gap:0.8rem; flex-wrap:wrap; }
  .sale-code-label { font-size:0.62rem; color:rgba(255,255,255,0.75); letter-spacing:0.08em; }
  .sale-code { background:rgba(255,255,255,0.15); border:1px dashed rgba(255,255,255,0.5); color:#fff; font-family:'Inter',sans-serif; font-size:0.78rem; font-weight:700; letter-spacing:0.22em; padding:0.3rem 0.75rem; cursor:pointer; transition:background 0.2s; }
  .sale-code:hover { background:rgba(255,255,255,0.25); }
  /* Countdown */
  .sale-countdown-wrap { flex-shrink:0; text-align:center; }
  .sale-countdown-label { font-size:0.5rem; letter-spacing:0.25em; text-transform:uppercase; color:rgba(255,200,200,0.8); margin-bottom:0.6rem; }
  .sale-countdown { display:flex; align-items:flex-start; gap:0.4rem; }
  .cd-block { background:rgba(0,0,0,0.35); border:1px solid rgba(255,255,255,0.18); padding:0.65rem 0.85rem; text-align:center; min-width:56px; backdrop-filter:blur(4px); }
  .cd-num { font-family:'Inter',sans-serif; font-size:1.7rem; font-weight:700; color:#fff; line-height:1; display:block; }
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
  .summer-badge { position:absolute; top:8px; right:8px; z-index:5; background:linear-gradient(135deg,#c0392b,#962d22); color:#fff; font-size:0.48rem; letter-spacing:0.16em; font-weight:700; padding:0.28rem 0.5rem; font-family:'Inter',sans-serif; box-shadow:0 3px 8px rgba(192,57,43,0.5); }
  /* Product page sale countdown */
  .prod-sale-timer { display:flex; align-items:center; gap:0.6rem; margin-top:0.5rem; flex-wrap:wrap; }
  .prod-cd-label { font-size:0.52rem; letter-spacing:0.14em; text-transform:uppercase; color:#e87070; }
  .prod-cd { display:flex; gap:0.25rem; align-items:flex-start; }
  .prod-cd-block { background:rgba(139,26,26,0.2); border:1px solid rgba(180,40,40,0.35); padding:0.3rem 0.45rem; text-align:center; min-width:34px; }
  .prod-cd-num { font-family:'Inter',sans-serif; font-size:0.9rem; font-weight:700; color:#e87070; display:block; line-height:1; }
  .prod-cd-lbl { font-size:0.35rem; letter-spacing:0.1em; text-transform:uppercase; color:rgba(232,112,112,0.7); display:block; }
  .prod-cd-sep { font-size:0.9rem; color:rgba(232,112,112,0.5); line-height:1.4; font-weight:300; }

  /* FEATURED BOOKS */
  .featured { background: var(--bg2); }
  .featured-header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 4rem; }
  .tabs { display: flex; gap: 0.4rem; border-bottom: 1px solid var(--border); padding-bottom: 0; margin-top: 1.5rem; }
  .tab { font-size: 0.62rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--cream-dim); padding: 0.5rem 1.2rem 0.8rem; cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.3s; margin-bottom: -1px; background: none; border-top: none; border-left: none; border-right: none; font-family: 'Inter', sans-serif; }
  .tab.active { color: var(--gold); border-bottom-color: var(--gold); }
  .tab:hover { color: var(--gold-light); }

  /* Book grid */
  .books-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 1.4rem; width: 100%; max-width: 100%; }
  @media(max-width:1100px){ .books-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  @media(max-width:880px) { .books-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  .book-card { cursor: pointer; min-width: 0; max-width: 100%; touch-action: manipulation; }
  .book-cover { aspect-ratio: 2/3; max-height: 320px; position: relative; overflow: hidden; margin-bottom: 1rem; border: 1px solid var(--border); background: #1a1208; display: flex; align-items: center; justify-content: center; transition: border-color 0.35s ease, box-shadow 0.35s ease; touch-action: manipulation; }
  /* Hover effects only on devices that truly support hover (mouse/trackpad).
     On touch-only screens :hover is sticky — it activates on first tap and
     blocks navigation until the second tap. @media(hover:hover) prevents this. */
  @media(hover:hover) {
    .book-card:hover .book-cover { border-color: rgba(201,168,76,0.55); box-shadow: 0 12px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(201,168,76,0.15); }
    .book-card:hover .book-cover img { transform: scale(1.06); }
    .book-card:hover .book-cover-overlay { opacity: 1; }
  }
  /* contain (not cover) so wide combo images aren't cropped — full image always visible */
  .book-cover img { width: 100%; height: 100%; object-fit: contain; display: block; transition: transform 0.5s ease; }
  @media(max-width:780px) { .book-cover { max-height: 220px; margin-bottom: 0.7rem; } }
  .book-cover-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.65); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.6rem; opacity: 0; transition: opacity 0.3s; padding: 1rem; pointer-events: none; }
  .book-cover-title { font-family: 'Cormorant Garamond', serif; font-size: 0.9rem; color: var(--white); text-align: center; line-height: 1.3; }
  .btn-add { font-size: 0.58rem; letter-spacing: 0.22em; text-transform: uppercase; color: var(--bg); background: var(--gold); border: none; padding: 0.7rem 1.4rem; cursor: pointer; font-family: 'Inter', sans-serif; font-weight: 500; transition: background 0.3s; }
  .btn-add:hover { background: var(--gold-light); }

  /* Always-visible Add to Cart button below each book card */
  .btn-add-card { width: 100%; max-width: 100%; margin-top: 0.6rem; font-family: 'Inter', sans-serif; font-size: 0.54rem; letter-spacing: 0.18em; text-transform: uppercase; padding: 0.55rem 0.4rem; background: transparent; color: var(--gold); border: 1px solid rgba(201,168,76,0.4); cursor: pointer; font-weight: 500; transition: all 0.25s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .btn-add-card:hover { background: var(--gold); color: var(--bg); border-color: var(--gold); }
  .btn-add-card:active { transform: scale(0.98); }
  html[data-theme="light"] .btn-add-card { color: var(--gold); border-color: rgba(138,106,31,0.4); }
  html[data-theme="light"] .btn-add-card:hover { background: var(--gold); color: #fff; }

  /* "NEW" arrival ribbon */
  .new-badge { position: absolute; top: 8px; left: 8px; z-index: 5; background: linear-gradient(135deg, #c04336, #a2352a); color: #fff; font-size: 0.55rem; letter-spacing: 0.2em; font-weight: 600; padding: 0.3rem 0.6rem; font-family: 'Inter', sans-serif; box-shadow: 0 4px 10px rgba(185,66,54,0.45); animation: newPulse 2.4s ease-in-out infinite; }
  @keyframes newPulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.06); } }
  .book-name { font-family: 'Cormorant Garamond', serif; font-size: 1.04rem; font-weight: 600; color: var(--white); margin-bottom: 0.25rem; line-height: 1.22; letter-spacing: 0.005em; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; min-height:2.3em; }
  .book-author { font-size: 0.64rem; font-weight: 500; color: var(--gold-dim); letter-spacing: 0.07em; text-transform: uppercase; margin-bottom: 0.4rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .book-meta { display: flex; justify-content: space-between; align-items: baseline; gap:0.4rem; }
  .book-price { font-family: 'Cormorant Garamond', serif; font-size: 1.18rem; color: var(--gold); font-weight: 700; white-space:nowrap; }
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
  .pincode-input { flex:1; background:var(--bg3); border:1px solid var(--border); color:var(--cream); padding:0.85rem 1.2rem; font-family:'Inter',sans-serif; font-size:0.82rem; outline:none; letter-spacing:0.1em; }
  .pincode-input:focus { border-color:var(--gold-dim); }
  .pincode-btn { font-family:'Inter',sans-serif; font-size:0.62rem; letter-spacing:0.2em; text-transform:uppercase; padding:0.85rem 1.6rem; background:var(--gold); color:var(--bg); border:none; cursor:pointer; font-weight:500; white-space:nowrap; }
  .pincode-result { margin-top:0.8rem; font-size:0.78rem; min-height:1.4em; }

  /* Load more */
  .load-more-wrap { text-align: center; margin-top: 3.5rem; }
  .btn-load-more { font-family: 'Inter', sans-serif; font-size: 0.62rem; letter-spacing: 0.22em; text-transform: uppercase; padding: 0.9rem 2.4rem; border: 1px solid var(--gold-dim); color: var(--gold); background: transparent; cursor: pointer; transition: all 0.3s; }
  .btn-load-more:hover { background: var(--gold); color: var(--bg); }
  .books-count { font-size: 0.62rem; color: var(--cream-dim); letter-spacing: 0.1em; margin-top: 1rem; }

  /* Search bar */
  .search-wrap { margin-bottom: 2rem; max-width: 760px; }
  .search-box { position: relative; display: flex; align-items: center; background: var(--bg3); border: 1px solid var(--border); transition: border-color 0.25s, box-shadow 0.25s; }
  .search-box:focus-within { border-color: var(--gold); box-shadow: 0 0 0 3px rgba(201,168,76,0.12); }
  .search-icon { position: absolute; left: 1rem; color: var(--gold); font-size: 0.9rem; opacity: 0.9; pointer-events: none; }
  .search-input { width: 100%; background: transparent; border: 0; color: var(--cream); padding: 0.95rem 3rem 0.95rem 2.7rem; font-family: 'Inter', sans-serif; font-size: 0.86rem; outline: none; transition: border-color 0.3s; letter-spacing: 0.02em; }
  .search-input::placeholder { color: var(--cream-dim); }
  .search-clear { position: absolute; right: 0.45rem; width: 34px; height: 34px; border: 0; background: transparent; color: var(--cream-dim); cursor: pointer; font-size: 1.15rem; line-height: 1; display: none; align-items: center; justify-content: center; }
  .search-clear.show { display: inline-flex; }
  .search-clear:hover { color: var(--gold); }
  .search-hints { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-top: 0.75rem; }
  .search-chip { border: 1px solid var(--border); background: transparent; color: var(--cream-dim); font-family: 'Inter', sans-serif; font-size: 0.58rem; letter-spacing: 0.12em; text-transform: uppercase; padding: 0.42rem 0.7rem; cursor: pointer; }
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
  .srch-input{flex:1;background:transparent;border:0;color:var(--cream);padding:1rem 3rem 1rem 3rem;font-family:'Inter',sans-serif;font-size:0.9rem;outline:none;letter-spacing:0.02em;}
  .srch-input::placeholder{color:var(--cream-dim);}
  .srch-cls{background:none;border:none;color:var(--cream-dim);cursor:pointer;font-size:1.4rem;padding:0.9rem 1rem;line-height:1;transition:color 0.2s;}
  .srch-cls:hover{color:var(--gold);}
  .srch-chips{display:flex;flex-wrap:wrap;gap:0.45rem;margin-top:0.85rem;}
  .srch-results{margin-top:0.9rem;max-height:min(56vh,460px);overflow-y:auto;border:1px solid var(--border);background:var(--bg3);display:none;}
  .srch-results.has{display:block;}
  .srch-hit{display:flex;align-items:center;gap:0.9rem;padding:0.65rem 0.9rem;cursor:pointer;text-decoration:none;color:inherit;border-bottom:1px solid var(--border);transition:background 0.15s;}
  .srch-hit:last-child{border-bottom:none;}
  .srch-hit:hover,.srch-hit.sel{background:rgba(201,168,76,0.09);}
  .srch-hit-img{width:38px;height:56px;flex-shrink:0;background:var(--bg2);overflow:hidden;border:1px solid var(--border);}
  .srch-hit-img img{width:100%;height:100%;object-fit:cover;display:block;}
  .srch-hit-info{flex:1;min-width:0;}
  .srch-hit-title{font-family:'Cormorant Garamond',serif;font-size:0.98rem;font-weight:600;color:var(--white);line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .srch-hit-title mark{background:transparent;color:var(--gold);font-weight:700;}
  .srch-hit-author{font-size:0.62rem;color:var(--cream-dim);letter-spacing:0.06em;margin-top:0.1rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .srch-hit-price{font-family:'Cormorant Garamond',serif;font-size:1.02rem;font-weight:700;color:var(--gold);white-space:nowrap;}
  .srch-all{display:block;text-align:center;padding:0.75rem;font-family:'Inter',sans-serif;font-size:0.62rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--gold);cursor:pointer;background:rgba(201,168,76,0.05);border:none;width:100%;border-top:1px solid var(--border);}
  .srch-all:hover{background:rgba(201,168,76,0.12);}
  .srch-kbd{display:inline-block;border:1px solid var(--border);border-radius:3px;padding:0 0.35rem;font-size:0.62rem;color:var(--cream-dim);font-family:'Inter',sans-serif;line-height:1.5;}

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
  .coll-cta { font-size: 0.58rem; letter-spacing: 0.22em; text-transform: uppercase; color: var(--gold); margin-top: 1rem; opacity: 0; transform: translateY(6px); transition: all 0.3s; font-family: 'Inter',sans-serif; }
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
  .newsletter-input { flex: 1; background: var(--bg3); border: 1px solid var(--border); border-right: none; color: var(--cream); padding: 0.9rem 1.4rem; font-family: 'Inter', sans-serif; font-size: 0.75rem; letter-spacing: 0.05em; outline: none; transition: border-color 0.3s; }
  .newsletter-input::placeholder { color: var(--cream-dim); }
  .newsletter-input:focus { border-color: var(--gold-dim); }
  .btn-subscribe { font-family: 'Inter', sans-serif; font-size: 0.6rem; letter-spacing: 0.22em; text-transform: uppercase; padding: 0.9rem 1.8rem; background: var(--gold); color: var(--bg); border: none; cursor: pointer; font-weight: 500; transition: background 0.3s; white-space: nowrap; }
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
  .footer-business { display: flex; flex-wrap: wrap; gap: 0.4rem 1.4rem; padding: 1.6rem 0; margin-top: 1rem; border-top: 1px solid var(--border); font-size: 0.66rem; color: var(--cream-dim); letter-spacing: 0.02em; line-height: 1.7; }
  .footer-business strong { color: var(--gold); font-weight: 600; }
  .footer-business a { color: var(--gold-dim); text-decoration: none; }
  .footer-business a:hover { color: var(--gold); }
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
  .shelf-card { flex: 0 0 155px; scroll-snap-align: start; cursor: pointer; touch-action: manipulation; }
  .shelf-card-cover { aspect-ratio: 2/3; background: var(--bg2); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; overflow: hidden; margin-bottom: 0.6rem; transition: border-color 0.25s; }
  .shelf-card-cover img { width: 100%; height: 100%; object-fit: contain; display: block; transition: transform 0.35s; }
  @media(hover:hover) {
    .shelf-card:hover .shelf-card-cover { border-color: var(--gold-dim); }
    .shelf-card:hover .shelf-card-cover img { transform: scale(1.04); }
  }
  .shelf-card-name { font-family: 'Cormorant Garamond', serif; font-size: 0.88rem; color: var(--cream); line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 2.2em; }
  .shelf-card-price { font-size: 0.85rem; color: var(--gold); font-weight: 600; margin-top: 0.25rem; }
  .shelf-card-btn { width: 100%; margin-top: 0.45rem; font-size: 0.5rem; letter-spacing: 0.15em; text-transform: uppercase; padding: 0.52rem 0.25rem; background: transparent; color: var(--gold); border: 1px solid rgba(201,168,76,0.4); cursor: pointer; font-family: 'Inter', sans-serif; font-weight: 500; transition: all 0.2s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .shelf-card-btn:hover { background: var(--gold); color: var(--bg); border-color: var(--gold); }
  @media(max-width:1100px) { .shelves-section { padding: 5rem 2.5rem; } }
  @media(max-width:600px) { .shelves-section { padding: 3.2rem 0.85rem; } .shelf-card { flex: 0 0 128px; } .shelf-title { font-size: 1.4rem; } }

  /* AUTHOR SPOTLIGHT */
  .author-spotlight { max-width: 1400px; margin: 0 auto; padding: 5rem 3rem 4.5rem; }
  .author-row { display: flex; gap: 1.8rem; overflow-x: auto; scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; scrollbar-width: none; padding-bottom: 0.8rem; margin-top: 2.5rem; }
  .author-row::-webkit-scrollbar { display: none; }
  .author-card { flex: 0 0 172px; scroll-snap-align: start; text-decoration: none; text-align: center; }
  .author-photo-wrap { width: 100%; aspect-ratio: 1 / 1; overflow: hidden; border-radius: 10px; border: 1px solid var(--border); background: var(--bg2); margin-bottom: 1rem; }
  .author-photo-wrap img { width: 100%; height: 100%; object-fit: cover; object-position: top center; display: block; transition: transform 0.35s; }
  .author-card:hover .author-photo-wrap img { transform: scale(1.05); }
  .author-card:hover .author-photo-wrap { border-color: var(--gold-dim); }
  .author-card-label { font-size: 0.52rem; letter-spacing: 0.22em; text-transform: uppercase; color: var(--gold); margin-bottom: 0.3rem; }
  .author-card-name { font-family: 'Cormorant Garamond', serif; font-size: 1.05rem; font-weight: 400; color: var(--cream); line-height: 1.25; }
  .author-card-cta { font-size: 0.54rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--gold-dim); margin-top: 0.25rem; }
  @media(max-width:1100px) { .author-spotlight { padding: 4rem 2.5rem; } }
  @media(max-width:600px) { .author-spotlight { padding: 3.2rem 1rem; } .author-card { flex: 0 0 130px; } }

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
  .cat-name { font-family: 'Inter', sans-serif; font-size: 0.72rem; font-weight: 500; color: var(--cream); line-height: 1.3; }
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
  .prod-desc { font-size:0.95rem; color:var(--cream); line-height:1.85; letter-spacing:0.01em; font-family:var(--font-serif); border-top:1px solid var(--border); padding-top:1rem; }
  .prod-actions { display:flex; gap:0.8rem; margin-top:auto; padding-top:1rem; border-top:1px solid var(--border); }
  .prod-btn-cart { flex:1; font-family:'Inter',sans-serif; font-size:0.62rem; letter-spacing:0.22em; text-transform:uppercase; padding:0.9rem 1rem; background:var(--gold); color:var(--bg); border:none; cursor:pointer; font-weight:500; transition:background 0.3s; }
  .prod-btn-cart:hover { background:var(--gold-light); }
  .prod-btn-share { font-family:'Inter',sans-serif; font-size:0.62rem; letter-spacing:0.18em; text-transform:uppercase; padding:0.9rem 1.2rem; background:transparent; color:var(--cream-dim); border:1px solid var(--border); cursor:pointer; transition:all 0.3s; }
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
  .btn-checkout { width:100%; font-family:'Inter',sans-serif; font-size:0.65rem; letter-spacing:0.25em; text-transform:uppercase; padding:1rem; background:var(--gold); color:var(--bg); border:none; cursor:pointer; font-weight:500; transition:all 0.3s; }
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
    .nav-links { order: 4; display: flex; flex-wrap: nowrap; width: 100%; gap: 0.55rem; overflow-x: auto; -webkit-overflow-scrolling: touch; padding: 0.35rem 0 0.15rem; scrollbar-width: none; }
    .nav-links::-webkit-scrollbar { display: none; }
    .nav-links li { flex: 0 0 auto; }
    /* Amazon-style: search drops to its own full-width row (below logo/icons,
       above the scrolling category links). */
    .nav-break { display: none; }
    .nav-search { order: 3; flex: 0 0 100%; width: 100%; max-width: none; min-width: 0; margin: 0.5rem 0 0.1rem; padding: 0.45rem 0.5rem 0.45rem 1rem; }
    .nav-search input { font-size: 0.9rem; }
    .nav-search button { padding: 0.5rem 0.8rem; font-size: 1.05rem; }
    /* !important beats the global `.nav-links a{font-size:.82rem!important}` rule
       (line ~647) that would otherwise inflate these into big wrapping pills. */
    .nav-links a { display: inline-flex; min-height: 34px; align-items: center; padding: 0 0.7rem !important; border: 1px solid var(--border); background: rgba(201,168,76,0.05); font-size: 0.6rem !important; letter-spacing: 0.13em; white-space: nowrap; }
    .nav-dropdown-trigger::after, .nav-dropdown { display: none; }
    .nav-actions { gap: 0.7rem; min-width: 0; }
    .nav-actions .btn-nav, .nav-actions .nav-cart-wrap { display: none; }
    .theme-toggle { width: 34px; height: 34px; margin-right: 0; flex: 0 0 auto; }
    .nav-icon { flex: 0 0 44px; width:44px; height:44px; display:inline-flex; align-items:center; justify-content:center; font-size:1.18rem; }
    .nav-search-btn { flex: 0 0 auto; min-width: 86px; height: 42px; border: 1px solid var(--border); padding: 0 0.75rem; gap: 0.42rem; font-family: 'Inter', sans-serif; color: var(--gold); background: rgba(201,168,76,0.06); }
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
  .promo-banner{background:linear-gradient(90deg,#1a1410,#2a1f15,#1a1410);border-bottom:1px solid rgba(201,168,76,0.25);padding:0.55rem 1rem;text-align:center;font-size:0.66rem;letter-spacing:0.12em;color:#f0e8d8;font-family:'Inter',sans-serif;position:relative;z-index:200}
  .promo-banner strong{color:#c9a84c;font-weight:600;letter-spacing:0.18em}
  .promo-banner code{background:rgba(201,168,76,0.18);color:#c9a84c;padding:0.15rem 0.55rem;border:1px dashed rgba(201,168,76,0.5);font-family:'Inter',sans-serif;font-size:0.62rem;letter-spacing:0.15em;margin-left:0.5rem}
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

  /* ── Light-theme notes ──────────────────────────────────────────
     Almost every component already colours itself from the theme vars, so
     flipping the palette is enough. The one thing that was genuinely missing
     was a light value for the --glass-* tokens (see the light :root above):
     `.search-box,.srch-results,.cart-sidebar{background:var(--glass-bg)!important}`
     was painting the cart panel near-black under near-black text (1.03:1).

     Deliberately NOT overridden: .kog-*, .slide-campus, .new-badge and
     .iac-cap. Those sit on their own dark gradient panels or scrims, so their
     pale ink is correct in both themes — a contrast audit that walks up for a
     background-color misses `background-image` and reports them as failures. */

  .mob-nav a,.mob-nav button{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:0.45rem 0;background:transparent;border:none;color:var(--cream-dim);font-family:'Inter',sans-serif;font-size:0.55rem;letter-spacing:0.12em;text-transform:uppercase;cursor:pointer;text-decoration:none;transition:color 0.2s;position:relative}
  .mob-nav a:hover,.mob-nav button:hover,.mob-nav a:active,.mob-nav button:active{color:var(--gold)}
  .mob-nav .mn-icon{font-size:1.25rem;line-height:1}
  .mob-nav .mn-badge{position:absolute;top:0;right:calc(50% - 18px);background:var(--gold);color:var(--bg);border-radius:50%;width:16px;height:16px;font-size:0.55rem;font-weight:600;display:flex;align-items:center;justify-content:center;letter-spacing:0}

  /* Trust strip — Why Choose Ink & Chai */
  .trust-strip{display:grid;grid-template-columns:repeat(6,1fr);gap:1.5rem;max-width:1240px;margin:0 auto;padding:2.5rem 2rem;border-bottom:1px solid var(--border)}
  .trust-item{display:flex;flex-direction:column;align-items:center;text-align:center;gap:0.5rem}
  .trust-link{text-decoration:none}
  .trust-link:hover .trust-title{color:var(--gold)}
  .trust-icon{font-size:1.6rem;color:var(--gold)}
  .trust-title{font-family:'Cormorant Garamond',serif;font-size:1rem;color:var(--cream);font-weight:500}
  .trust-text{font-size:0.7rem;color:var(--cream-dim);line-height:1.5;letter-spacing:0.03em}
  @media(max-width:980px){.trust-strip{grid-template-columns:repeat(3,1fr)}}
  @media(max-width:780px){.trust-strip{grid-template-columns:repeat(2,1fr);gap:1.2rem;padding:1.8rem 1rem}.trust-title{font-size:0.85rem}.trust-text{font-size:0.62rem}}

  /* ════════ Polish layer (Fable 5) — micro-interactions & accessibility ════════ */
  /* Keyboard focus rings — gold, only on keyboard nav (not mouse clicks) */
  a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
    outline: 2px solid var(--gold); outline-offset: 2px; border-radius: 1px;
  }
  /* Primary buttons: lift + soft glow on hover, satisfying press */
  .btn-primary { position: relative; overflow: hidden; will-change: transform; }
  .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 12px 30px rgba(201,168,76,0.28); }
  .btn-primary:active { transform: translateY(0); box-shadow: 0 4px 12px rgba(201,168,76,0.22); }
  /* Shine sweep across primary CTA on hover */
  .btn-primary::after {
    content:''; position:absolute; top:0; left:-120%; width:60%; height:100%;
    background: linear-gradient(120deg, transparent, rgba(255,255,255,0.35), transparent);
    transform: skewX(-20deg); transition: left 0.6s ease; pointer-events:none;
  }
  .btn-primary:hover::after { left: 140%; }
  /* Outline / nav buttons: gentle fill lift */
  .btn-nav:hover, .btn-ghost:hover { transform: translateY(-1px); }
  .btn-add-card:active { transform: scale(0.97); }
  /* Add-to-cart "added" success flash */
  .btn-add-card.added, .shelf-card-btn.added {
    background: var(--gold) !important; color: var(--bg) !important; border-color: var(--gold) !important;
  }
  @keyframes iacPop { 0%{transform:scale(1)} 40%{transform:scale(1.12)} 100%{transform:scale(1)} }
  .iac-pop { animation: iacPop 0.32s cubic-bezier(0.34,1.56,0.64,1); }
  /* Cart badge pop when count changes */
  @keyframes badgePop { 0%{transform:scale(0.4);opacity:0} 60%{transform:scale(1.25)} 100%{transform:scale(1);opacity:1} }
  .cart-badge.bump, .mn-badge.bump { animation: badgePop 0.4s cubic-bezier(0.34,1.56,0.64,1); }
  /* Book cards: graceful entrance as they scroll into view */
  @keyframes cardRise { from{opacity:0;transform:translateY(22px)} to{opacity:1;transform:translateY(0)} }
  .book-card.reveal { animation: cardRise 0.55s cubic-bezier(0.22,0.61,0.36,1) both; }
  /* Price tag subtle weight emphasis on card hover */
  .book-card:hover .book-price, .book-card:hover .price { color: var(--gold-light); }
  /* Image lazy-load fade-in */
  .book-cover img { opacity: 0; transition: opacity 0.5s ease, transform 0.5s ease; }
  .book-cover img.loaded, .book-cover img[data-loaded] { opacity: 1; }
  /* Nav links: animated underline */
  .nav-links a { position: relative; }
  .nav-links a::after {
    content:''; position:absolute; left:0; bottom:-3px; width:100%; height:1px;
    background: var(--gold); transform: scaleX(0); transform-origin: right;
    transition: transform 0.28s ease;
  }
  .nav-links a:hover::after { transform: scaleX(1); transform-origin: left; }
  /* Smoother sidebar / overlay easing already exists; add cart item hover */
  .cart-item { transition: background 0.2s ease; }
  .cart-item:hover { background: rgba(201,168,76,0.04); }
  /* Respect reduced-motion preference globally */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; scroll-behavior: auto !important; }
    .btn-primary::after { display: none; }
  }
  /* ════════ end polish layer ════════ */

/* Sitewide liquid glass UI refresh */
:root{
  --bg:#090807;
  --bg2:#11100f;
  --bg3:#1b1713;
  --gold:#d6b85e;
  --gold-light:#f0d889;
  --gold-dim:#9c8244;
  --cream:#f4ecdc;
  --cream-dim:#b9ab96;
  --border:rgba(214,184,94,.22);
  --pill:999px;
  --ink-blue:#182d3b;
  --wine:#4b2026;
  --sage:#24362f;
  --copper:#b8754c;
  --glass-bg:rgba(17,15,13,.74);
  --glass-ink:rgba(13,11,8,.66);
  --glass-border:rgba(214,184,94,.28);
  --glass-shadow:0 18px 60px rgba(0,0,0,.46);
  --glass-highlight:inset 0 1px rgba(255,255,255,.1);
}
/* The glass surfaces (cart sidebar, search box, search results) had no light
   values, and they are painted with `background: var(--glass-bg) !important`.
   So on a pale page the cart kept its near-black panel while its text turned
   near-black too — 1.03:1, the worst contrast on the site. The checkout
   template already defined these; the shared one never did. */
html[data-theme="light"]{
  /* Injected widgets (cart recommendations in public/js/cart.js) read
     var(--muted,...) with a dark-theme fallback; the shared palette only ever
     defined --cream-dim, so they kept the dark grey on a pale panel. */
  --muted:#4e4032;
  --copper:#7d4f2c;
  --glass-bg:rgba(255,253,250,.86);
  --glass-ink:rgba(255,253,250,.78);
  --glass-border:rgba(138,106,31,.26);
  --glass-shadow:0 18px 60px rgba(70,52,24,.14);
  --glass-highlight:inset 0 1px rgba(255,255,255,.72);
}
/* Shared with public/js/cart.js, which injects the free-shipping
   confirmations inline and so cannot use a theme-scoped selector. */
html{--ship-free:#2f6e37}
html:not([data-theme="light"]){--ship-free:#6dbf6d}
html:not([data-theme="light"]){
  color-scheme:dark;
}
html[data-theme="light"]{
  color-scheme:light;
}
body{
  background:
    linear-gradient(115deg,rgba(24,45,59,.34) 0%,transparent 28%,transparent 64%,rgba(75,32,38,.24) 100%),
    linear-gradient(180deg,rgba(214,184,94,.08),transparent 34%,rgba(36,54,47,.14)),
    repeating-linear-gradient(90deg,rgba(214,184,94,.034) 0 1px,transparent 1px 84px),
    var(--bg);
  overflow-x:clip;
}
/* Promo strip: full-width, pinned to the very top so it never overlaps the
   floating nav pill below it (previously a centered pill at the same y as the
   nav, which hid the nav buttons). */
.promo-banner{
  position:static;
  width:100%;
  margin:0;
  border:none;
  border-bottom:1px solid rgba(201,168,76,.24);
  border-radius:0;
  background:var(--glass-bg);
  box-shadow:0 4px 16px rgba(40,28,8,.10),var(--glass-highlight);
  backdrop-filter:blur(18px) saturate(1.2);
  z-index:96;
}
nav:not(.mob-nav){
  width:min(1540px,calc(100% - 28px));
  /* In normal flow now, so it centres with auto margins rather than the
     left:50% + translateX(-50%) pair it used while it was pinned. */
  margin:.7rem auto 0;
  border:1px solid var(--glass-border);
  border-radius:var(--pill);
  background:var(--glass-bg)!important;
  box-shadow:var(--glass-shadow),var(--glass-highlight);
  backdrop-filter:blur(24px) saturate(1.25);
  padding:.72rem 1rem .72rem 1.1rem;
  /* backdrop-filter makes this a stacking context, so the search dropdown
     inside it can never escape. Positioned + ranked above page content (but
     below the quick-view modal at 600) so the dropdown paints over the grid. */
  position:relative;
  z-index:300;
}
.nav-links a,.btn-nav,.theme-toggle,.nav-search-btn,.search-chip,.tab,.btn-primary,.btn-add-card,.shelf-card-btn,.btn-load-more,.pincode-btn,.btn-checkout,.qty-btn{
  border-radius:var(--pill);
}
.nav-links a{
  padding:.55rem .82rem;
  border:1px solid transparent;
}
.nav-links a:hover{
  background:rgba(201,168,76,.11);
  border-color:rgba(201,168,76,.2);
}
.nav-links a::after{display:none}
.theme-toggle,.nav-search-btn,.btn-nav{
  box-shadow:var(--glass-highlight);
  backdrop-filter:blur(14px);
}
.hero{padding-top:clamp(1.5rem,3vw,3rem)}
.hero-left{padding-left:clamp(1.25rem,5vw,6rem)}
.hero-title{letter-spacing:-.025em}
.hero-card::before,.hero-card::after{border-radius:26px}
.featured,.collections,.shelves-section,.author-spotlight,.all-categories,.newsletter,.pincode-section{
  max-width:min(1480px,calc(100% - 28px));
  margin-left:auto;
  margin-right:auto;
  border:1px solid rgba(201,168,76,.13);
  border-radius:38px;
  background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.015));
  box-shadow:0 24px 70px rgba(0,0,0,.12);
  overflow:hidden;
}
html[data-theme="light"] .featured,
html[data-theme="light"] .collections,
html[data-theme="light"] .shelves-section,
html[data-theme="light"] .author-spotlight,
html[data-theme="light"] .all-categories,
html[data-theme="light"] .newsletter,
html[data-theme="light"] .pincode-section{
  background:linear-gradient(180deg,rgba(255,255,255,.72),rgba(250,247,242,.46));
  box-shadow:0 24px 70px rgba(70,52,24,.08);
}
.book-card,.shelf-card,.coll-card,.cat-card,.search-box,.srch-results,.srch-row,.newsletter-input,.pincode-input,.reader-activity-toast{
  border-radius:24px;
}
.book-card,.shelf-card,.cat-card,.coll-card{
  background:linear-gradient(155deg,rgba(255,255,255,.07),rgba(24,45,59,.1) 48%,rgba(75,32,38,.08));
  border:1px solid rgba(214,184,94,.16);
}
html[data-theme="light"] .book-card,
html[data-theme="light"] .shelf-card,
html[data-theme="light"] .cat-card,
html[data-theme="light"] .coll-card{
  background:rgba(255,255,255,.58);
}
.book-cover,.shelf-card-cover,.cat-icon{
  border-radius:22px;
}
.btn-add-card,.shelf-card-btn{
  min-height:42px;
  background:linear-gradient(135deg,rgba(214,184,94,.18),rgba(24,45,59,.16));
  box-shadow:var(--glass-highlight);
}
.search-box,.srch-results,.cart-sidebar{
  background:var(--glass-bg)!important;
  border:1px solid var(--glass-border);
  box-shadow:var(--glass-shadow),var(--glass-highlight);
  backdrop-filter:blur(24px) saturate(1.25);
}
.cart-overlay{background:rgba(13,11,8,.38);backdrop-filter:blur(8px)}
/* The cart is a full-height reading surface, not a floating accent, so it stays
   fully opaque. At --glass-bg's 0.86 alpha the dark hero showed through behind
   the item titles, and iOS "Reduce Transparency" drops the blur altogether. */
html[data-theme="light"] .cart-sidebar{background:#fffdfa!important}
html:not([data-theme="light"]) .cart-sidebar{background:#15120f!important}
.cart-sidebar{
  top:14px;
  right:14px;
  bottom:14px;
  border-radius:34px;
  overflow:hidden;
}
.cart-header,.cart-footer{
  background:rgba(255,255,255,.08);
  backdrop-filter:blur(14px);
}
html[data-theme="light"] .cart-header,
html[data-theme="light"] .cart-footer{background:rgba(255,255,255,.42)}
.section-kicker,.hero-kicker,.sale-eyebrow,.trust-title,.book-category,.shelf-card-category,.cat-count,.marquee-item,.reader-activity-kicker{
  border-radius:var(--pill);
}
.hero-kicker,.section-kicker,.sale-eyebrow{
  display:inline-flex;
  align-items:center;
  gap:.55rem;
  padding:.38rem .72rem;
  border:1px solid rgba(214,184,94,.2);
  background:rgba(214,184,94,.075);
  box-shadow:var(--glass-highlight);
}
.search-chip,.tab{
  background:rgba(255,255,255,.045);
  border:1px solid rgba(214,184,94,.16);
  padding:.52rem .9rem;
}
.tab.active,.search-chip:hover{
  background:linear-gradient(135deg,rgba(214,184,94,.2),rgba(184,117,76,.12));
  border-color:rgba(214,184,94,.36);
}
.coll-card,.cat-card,.shelf-card,.book-card{
  box-shadow:0 14px 38px rgba(0,0,0,.18),var(--glass-highlight);
}
.book-card:hover,.shelf-card:hover,.cat-card:hover,.coll-card:hover{
  border-color:rgba(214,184,94,.36);
  box-shadow:0 20px 48px rgba(0,0,0,.28),0 0 0 1px rgba(214,184,94,.08),var(--glass-highlight);
}
.book-price,.price,.cart-total-amount{
  color:var(--gold-light);
}
.btn-primary,.btn-checkout{
  background:linear-gradient(135deg,var(--gold),var(--copper));
  color:#100c08;
  border-color:rgba(240,216,137,.58);
}
/* The gradient is built from --gold/--copper, which are dark on a pale page, so
   the near-black ink above only works in the dark theme. (.btn-checkout is
   separately repainted with a pale gradient !important, so it keeps dark ink.) */
html[data-theme="light"] .btn-primary{
  color:#fff;
  border-color:rgba(122,90,18,.5);
}
.btn-nav:hover,.btn-add-card:hover,.shelf-card-btn:hover,.btn-load-more:hover,.pincode-btn:hover{
  background:linear-gradient(135deg,rgba(214,184,94,.28),rgba(184,117,76,.2));
  color:var(--gold-light);
}
.newsletter-input,.pincode-input,.search-input{
  background:rgba(255,255,255,.055);
  border-radius:var(--pill);
}
.footer,.marquee-bar{
  background:linear-gradient(135deg,#090807,var(--ink-blue) 52%,#120d09);
}
.footer-bottom-links{flex-wrap:wrap;justify-content:flex-end;min-width:0}
.shelf-row,.author-row,.tabs,.search-hints,.nav-links{max-width:100%;overscroll-behavior-x:contain}
@media(max-width:780px){
  .promo-banner{
    /* The strip and the nav below it both sit in normal flow and scroll away
       with the page; only .mob-nav (the bottom bar) stays pinned. */
    position:static;
    width:100%;
    margin:0;
    border-radius:0;
    padding:.44rem .8rem;
    white-space:normal;
    line-height:1.45;
    z-index:96;
  }
  nav:not(.mob-nav){
    width:calc(100% - 18px);
    border-radius:28px;
    padding:.6rem .72rem;
    transition:padding .22s ease;
  }
  .hero{padding-top:1.2rem}
  .hero-title{font-size:clamp(2.65rem,13vw,4rem);line-height:.96;letter-spacing:0}
  .hero-desc{font-size:.94rem;line-height:1.72}
  .section-title{font-size:clamp(2rem,10vw,2.7rem);letter-spacing:0}
  .featured,.collections,.shelves-section,.author-spotlight,.all-categories,.newsletter,.pincode-section{
    max-width:calc(100% - 18px);
    border-radius:28px;
  }
  .mob-nav{
    left:12px!important;
    right:12px!important;
    bottom:10px!important;
    border:1px solid var(--glass-border)!important;
    border-radius:28px!important;
    background:rgba(250,247,242,.58)!important;
    box-shadow:0 -12px 36px rgba(40,28,8,.18),var(--glass-highlight)!important;
    backdrop-filter:blur(24px) saturate(1.35)!important;
    padding:.42rem .45rem calc(.42rem + env(safe-area-inset-bottom,0px))!important;
  }
  html:not([data-theme="light"]) .mob-nav{
    background:rgba(13,11,8,.55)!important;
    box-shadow:0 -16px 42px rgba(0,0,0,.45),var(--glass-highlight)!important;
  }
  body{padding-bottom:90px!important}
  .book-name{font-size:1.08rem;line-height:1.25}
  .book-author{font-size:.68rem;line-height:1.4}
  .shelf-card{flex-basis:144px}
  .shelf-card-name{font-size:.98rem;line-height:1.3}
  .footer-bottom{align-items:flex-start;gap:1.2rem;flex-direction:column}
  .footer-bottom-links{width:100%;justify-content:flex-start;gap:.7rem 1.1rem}
  .footer-bottom-links a{font-size:.68rem;line-height:1.5}
  .mob-nav a,.mob-nav button{
    min-height:54px;
    border-radius:22px;
    transition:background .2s ease,color .2s ease,transform .2s ease;
  }
  .mob-nav a:active,.mob-nav button:active{
    background:rgba(201,168,76,.14);
    transform:translateY(-1px);
  }
  .wa-float{bottom:108px!important}
  .reader-activity-toast{bottom:152px}
  .cart-sidebar{
    inset:10px 10px calc(90px + env(safe-area-inset-bottom,0px));
    width:auto;
    border-radius:28px;
  }
}

</style>
</head>
<body>

<!--SALE:START-->
<!-- Independence Day promo banner -->
<div class="promo-banner" id="promoBanner">
  <strong>🇮🇳 FREEDOM SALE</strong> &nbsp;15% OFF on orders above ₹399 &nbsp;·&nbsp; Automatically applied &nbsp;·&nbsp; <code>FREEDOM</code> &nbsp;·&nbsp; Ends in: <span id="promoTimer" style="font-weight:600;color:#f0c060;letter-spacing:0.08em;"></span>
</div>
<!--SALE:END-->

<!--SALE:START-->
<!-- SUMMER SALE BANNER -->
<section class="summer-sale-banner" id="summerSale">
  <div class="summer-sale-inner">
    <div class="summer-sale-left">
      <div class="sale-eyebrow">🇮🇳 Independence Day &nbsp;·&nbsp; 15 August</div>
      <div class="sale-headline">Freedom Sale: 15% Off<br/><em>Orders Above ₹399</em></div>
      <div class="sale-code-row" style="margin-top:0.7rem;">
        <span class="sale-code-label">Automatically applied at checkout:</span>
        <span class="sale-code">FREEDOM</span>
      </div>
    </div>
    <div class="sale-countdown-wrap">
      <div class="sale-countdown-label">Sale ends in</div>
      <div class="sale-countdown" id="saleCountdown"></div>
    </div>
  </div>
</section>
<!--SALE:END-->

<!-- Floating WhatsApp support button -->
<a class="wa-float" href="https://wa.me/917678400508?text=Hi%20Ink%20%26%20Chai%2C%20I%20have%20a%20question%20about%20a%20book." target="_blank" rel="noopener" title="Chat with us on WhatsApp" aria-label="WhatsApp support">
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
    <li><a href="/books/">All Books</a></li>
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
  <span class="nav-break" aria-hidden="true"></span>
  <form class="nav-search" action="/" method="get" role="search"><input type="search" name="q" placeholder="Search books&hellip;" aria-label="Search books" autocomplete="off"/><button type="submit" aria-label="Search">&#128269;</button></form>
  <div class="nav-actions">
    <button class="theme-toggle" onclick="toggleTheme()" title="Toggle light/dark mode" aria-label="Toggle theme"><span class="moon">🌙</span><span class="sun">☀️</span></button>
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
      <div class="srch-results" id="srchResults" role="listbox" aria-label="Search suggestions"></div>
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

<!-- HERO PROMO CAROUSEL -->
<div class="promo-carousel" id="promoCarousel">

<!--SALE:START-->
  <!-- ── SLIDE 1: Freedom Sale ── -->
  <section class="promo-slide slide-sale active" aria-label="Freedom Sale promotion">
    <a href="/bestsellers/" class="sale-banner-link" aria-label="Freedom Sale — Shop Now" style="display:grid;place-items:center;min-height:100%;background:linear-gradient(115deg,#ff9933 0 32%,#fff8e8 32% 68%,#138808 68% 100%);text-decoration:none;color:#0b2f63;text-align:center;padding:2rem;">
      <div><div style="font-size:clamp(.7rem,1.4vw,1rem);letter-spacing:.25em;text-transform:uppercase;font-weight:800;">Ink &amp; Chai celebrates India</div><div style="font-family:'Cormorant Garamond',serif;font-size:clamp(2.2rem,6vw,5.5rem);line-height:.9;margin:.6rem 0;font-weight:700;">Freedom Sale</div><div style="font-size:clamp(1rem,2.5vw,1.8rem);font-weight:800;">15% OFF · ORDERS ABOVE ₹399</div><div style="margin-top:.8rem;font-size:.75rem;letter-spacing:.14em;">AUTO-APPLIED AT CHECKOUT · FREEDOM</div></div>
      <div class="sale-banner-code-badge">15% AUTO APPLIED</div>
    </a>
  </section>
<!--SALE:END-->

  <!-- ── SLIDE 2: Off Campus Series ── -->
  <section class="hero promo-slide slide-campus" style="padding:0;" aria-label="Off Campus series promotion">
    <div class="hero-left">
      <div class="hero-eyebrow">Elle Kennedy · Complete Series</div>
      <h2 class="hero-title">Off Campus<br/><em>all 5 books</em><br/>one order.</h2>
      <p class="hero-sub" style="display:none;" aria-hidden="true"></p><!-- hidden on mobile via CSS override below -->
      <p class="hero-sub hero-sub-desktop">The Deal, The Mistake, The Score, The Goal, The Legacy — complete Off Campus by Elle Kennedy. Addictive college romance that fans can't stop rereading.</p>
      <div class="hero-ctas">
        <a href="/product/off-campus-complete-5-book-collection-elle-kennedy/" class="btn-primary">Shop the Set — ₹1,499</a>
        <a href="/category/?name=All%20Romance%20Books" class="btn-ghost">More Romance</a>
      </div>
      <div class="hero-stats">
        <div><div class="stat-num">5</div><div class="stat-label">Books in one box</div></div>
        <div><div class="stat-num">₹1,499</div><div class="stat-label">Complete set</div></div>
        <div><div class="stat-num">COD</div><div class="stat-label">UPI available</div></div>
      </div>
    </div>
    <div class="hero-right" style="justify-content:center;">
      <div class="campus-img-wrap">
        <picture>
          <source srcset="/images/off-campus-5-book-collection-elle-kennedy-covers.webp" type="image/webp"/>
          <img src="/images/off-campus-5-book-collection-elle-kennedy-covers.webp" alt="Off Campus complete 5-book collection by Elle Kennedy" loading="lazy" width="420"/>
        </picture>
        <div class="campus-price-badge"><span>Only</span>₹1,499<span>5 books</span></div>
      </div>
    </div>
  </section>

  <!-- ── SLIDE 3: Hindi Self-Help Bestsellers ── -->
  <section class="hero promo-slide" style="padding:0;" aria-label="Hindi self-help bestsellers">
    <div class="hero-left">
      <div class="hero-eyebrow">Hindi self-help bestsellers</div>
      <h2 class="hero-title">Self-help<br/><em>bestsellers</em><br/>in Hindi.</h2>
      <p class="hero-sub hero-sub-desktop">Read the titles everyone talks about — David Goggins, Ben Horowitz, Daniel Kahneman, Robert Kiyosaki, James Clear, and more — in editions made for Indian readers.</p>
      <div class="hero-ctas">
        <a href="/hindi-books/" class="btn-primary">Shop Hindi Editions</a>
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
          <picture><source srcset="/images/cant-hurt-me-hindi.webp" type="image/webp"><img src="/images/cant-hurt-me-hindi.jpg" alt="Can't Hurt Me Hindi edition" loading="lazy"/></picture>
        </a>
        <a class="hero-cover-card" href="/product/never-finished-hindi-ED-HI/" data-label="Never Finished">
          <picture><source srcset="/images/never-finished-hindi.webp" type="image/webp"><img src="/images/never-finished-hindi.jpg" alt="Never Finished Hindi edition" loading="lazy"/></picture>
        </a>
        <a class="hero-cover-card featured" href="/product/the-hard-thing-about-hard-things-hindi-NG-HI/" data-label="The Hard Thing · Hindi">
          <picture><source srcset="/images/hard-thing-about-hard-things-hindi.webp" type="image/webp"><img src="/images/hard-thing-about-hard-things-hindi.jpg" alt="The Hard Thing About Hard Things Hindi edition" loading="lazy"/></picture>
        </a>
        <a class="hero-cover-card" href="/product/thinking-fast-and-slow-hindi-OW-HI/" data-label="Thinking, Fast and Slow">
          <picture><source srcset="/images/thinking-fast-slow-hindi.webp" type="image/webp"><img src="/images/thinking-fast-slow-hindi.jpg" alt="Thinking Fast and Slow Hindi edition" loading="lazy"/></picture>
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

  <!-- Navigation dots -->
  <div class="promo-dots" aria-label="Slide navigation">
<!--SALE:START-->
    <button class="promo-dot active" aria-label="Slide 1: Freedom Sale"></button>
<!--SALE:END-->
    <button class="promo-dot" aria-label="Slide 2: Off Campus Series"></button>
    <button class="promo-dot" aria-label="Slide 3: Hindi Bestsellers"></button>
  </div>
  <!-- Arrows -->
  <button class="promo-arrow prev" aria-label="Previous slide">&#8592;</button>
  <button class="promo-arrow next" aria-label="Next slide">&#8594;</button>
</div>

<!-- NEW ARRIVALS ROTATING FEATURE BANNER -->
<a class="kog-banner-wrap" id="featBannerLink" href="/product/the-divorce-by-freida-mcfadden-adden/" aria-label="Shop new arrivals at Ink &amp; Chai">
  <div class="kog-banner" id="featBanner">
    <!-- Spark particles -->
    <div class="kog-spark kog-spark-1"></div>
    <div class="kog-spark kog-spark-2"></div>
    <div class="kog-spark kog-spark-3"></div>
    <div class="kog-crown">✦</div>
    <!-- Book image (clickable via parent link) -->
    <div class="kog-book-wrap">
      <picture><img id="featImg" src="/images/the-divorce-freida-mcfadden.webp" alt="The Divorce by Freida McFadden" width="200" height="300"
           onerror="this.parentElement.style.display='none'" loading="eager" /></picture>
    </div>
    <!-- Price tag -->
    <div class="kog-price" id="featPrice">329</div>
    <!-- Left content -->
    <div class="kog-content">
      <div class="kog-store-label">Ink &amp; Chai — inkandchai.in</div>
      <div class="kog-series">
        <span class="kog-series-line"></span>
        <span class="kog-series-text" id="featSeries">New Arrival · Just Landed</span>
        <span class="kog-series-line"></span>
      </div>
      <div class="kog-title" id="featTitle">The<br/>Divorce</div>
      <div class="kog-subtitle" id="featSubtitle">A Psychological Thriller</div>
      <div class="kog-divider"></div>
      <div class="kog-author" id="featAuthor">by <strong>Freida McFadden</strong></div>
      <div class="kog-bestseller" id="featHook">From the #1 Bestselling Author of The Housemaid</div>
      <span class="kog-cta">Order Now <span class="kog-cta-arrow">→</span></span>
    </div>
  </div>
</a>
<script>
(function(){
  var FEATURED = [
    { title:'The<br>Divorce', subtitle:'A Psychological Thriller', author:'Freida McFadden',
      hook:'From the #1 Bestselling Author of The Housemaid', price:'329',
      img:'/images/the-divorce-freida-mcfadden.webp',
      href:'/product/the-divorce-by-freida-mcfadden-adden/' },
    { title:'Our Perfect<br>Storm', subtitle:'A Summer Romance', author:'Carley Fortune',
      hook:'Instant #1 New York Times Bestseller', price:'499',
      img:'/images/our-perfect-storm-carley-fortune.webp',
      href:'/product/our-perfect-storm-by-carley-fortune-rtune/' },
    { title:'The Midnight<br>Train', subtitle:'A Life-Changing Journey', author:'Matt Haig',
      hook:'From the Multi-Million Copy Bestselling Author', price:'369',
      img:'/images/the-midnight-train-matt-haig.jpg',
      href:'/product/the-midnight-train-by-matt-haig--haig/' },
    { title:'Whistler', subtitle:'A Novel', author:'Ann Patchett',
      hook:'From the Bestselling Author of The Dutch House', price:'369',
      img:'/images/whistler-ann-patchett.jpg',
      href:'/product/whistler-by-ann-patchett-chett/' }
  ];
  var banner = document.getElementById('featBanner');
  if (!banner || FEATURED.length < 2) return;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Preload images so swaps are instant
  FEATURED.forEach(function(f){ var im = new Image(); im.src = f.img; });

  var idx = 0, paused = false;
  var link = document.getElementById('featBannerLink');
  function apply(f){
    document.getElementById('featTitle').innerHTML    = f.title;
    document.getElementById('featSubtitle').textContent = f.subtitle;
    document.getElementById('featAuthor').innerHTML   = 'by <strong>' + f.author + '</strong>';
    document.getElementById('featHook').textContent   = f.hook;
    document.getElementById('featPrice').textContent  = f.price;
    var img = document.getElementById('featImg');
    img.src = f.img; img.alt = f.title.replace(/<br>/g,' ') + ' by ' + f.author;
    link.setAttribute('href', f.href);
    link.setAttribute('aria-label', 'Shop ' + f.title.replace(/<br>/g,' ') + ' by ' + f.author + ' — ₹' + f.price);
  }
  function rotate(){
    if (paused) return;
    idx = (idx + 1) % FEATURED.length;
    if (reduce) { apply(FEATURED[idx]); return; }
    banner.classList.add('kog-fading');
    setTimeout(function(){ apply(FEATURED[idx]); banner.classList.remove('kog-fading'); }, 500);
  }
  // Pause rotation while hovering so users can read/click
  banner.addEventListener('mouseenter', function(){ paused = true; });
  banner.addEventListener('mouseleave', function(){ paused = false; });
  setInterval(rotate, 5000);
})();
</script>

<!-- MARQUEE -->
<div class="marquee-bar">
  <div class="marquee-track">
    <span class="marquee-item">Free delivery on ₹499+ orders <span class="marquee-dot" aria-hidden="true">◆</span></span>
    <span class="marquee-item">Prepaid offers: 10% on ₹499+, 12% on ₹999+, 15% on ₹1499+ <span class="marquee-dot" aria-hidden="true">◆</span></span>
    <span class="marquee-item">Cash on delivery available <span class="marquee-dot" aria-hidden="true">◆</span></span>
    <span class="marquee-item">UPI, cards, and net banking accepted <span class="marquee-dot" aria-hidden="true">◆</span></span>
    <span class="marquee-item">7-day replacement support <span class="marquee-dot" aria-hidden="true">◆</span></span>
    <span class="marquee-item">Free delivery on ₹499+ orders <span class="marquee-dot" aria-hidden="true">◆</span></span>
    <span class="marquee-item">Prepaid offers: 10% on ₹499+, 12% on ₹999+, 15% on ₹1499+ <span class="marquee-dot" aria-hidden="true">◆</span></span>
    <span class="marquee-item">Cash on delivery available <span class="marquee-dot" aria-hidden="true">◆</span></span>
    <span class="marquee-item">UPI, cards, and net banking accepted <span class="marquee-dot" aria-hidden="true">◆</span></span>
    <span class="marquee-item">7-day replacement support <span class="marquee-dot" aria-hidden="true">◆</span></span>
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
    <div class="trust-icon">📦</div>
    <div class="trust-title">25,000+ Orders Fulfilled</div>
    <div class="trust-text">Trusted by readers across every state in India.</div>
  </div>
  <div class="trust-item">
    <div class="trust-icon"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" style="vertical-align:middle"><path fill="#1877F2" d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.68.88-3.34 2.19c-1.39-.46-2.9-.2-3.91.81s-1.26 2.52-.81 3.91c-1.31.67-2.19 1.91-2.19 3.34s.88 2.67 2.19 3.34c-.45 1.39-.2 2.9.81 3.91s2.52 1.26 3.91.81c.66 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34z"/><path fill="#fff" d="M10.09 15.42l-3.8-3.79 1.41-1.42 2.39 2.38 5.62-5.62 1.41 1.42z"/></svg></div>
    <div class="trust-title">Meta Verified Business</div>
    <div class="trust-text">Our identity is verified by Meta on Instagram &amp; Facebook.</div>
  </div>
  <a class="trust-item trust-link" href="https://www.instagram.com/inkandchai.in/" target="_blank" rel="noopener">
    <div class="trust-icon">◎</div>
    <div class="trust-title">12.4K Instagram Readers</div>
    <div class="trust-text">Follow @inkandchai.in for customer highlights, book drops, and unboxings.</div>
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

<!-- AUTHOR SPOTLIGHT -->
<section class="author-spotlight">
  <div class="section-label">Browse by Author</div>
  <h2 class="section-title">Author <em>Spotlight</em></h2>
  <div class="author-row">

    <a class="author-card" href="/category/?name=Colleen%20Hoover%20Special">
      <div class="author-photo-wrap">
        <picture>
          <img src="/images/colleen-hoover-author.jpg" alt="Colleen Hoover" loading="lazy" width="172" height="172"/>
        </picture>
      </div>
      <div class="author-card-label">Romance</div>
      <div class="author-card-name">Colleen Hoover</div>
      <div class="author-card-cta">View books →</div>
    </a>

    <a class="author-card" href="/category/?name=Ana%20Huang%20books">
      <div class="author-photo-wrap">
        <img src="/images/ana-huang-author.jpg" alt="Ana Huang" loading="lazy" width="172" height="172"/>
      </div>
      <div class="author-card-label">Romance</div>
      <div class="author-card-name">Ana Huang</div>
      <div class="author-card-cta">View books →</div>
    </a>

    <a class="author-card" href="/category/?name=Freida%20McFadden%20Special">
      <div class="author-photo-wrap">
        <img src="/images/freida-mcfadden-author.jpg" alt="Freida McFadden" loading="lazy" width="172" height="172"/>
      </div>
      <div class="author-card-label">Thriller</div>
      <div class="author-card-name">Freida McFadden</div>
      <div class="author-card-cta">View books →</div>
    </a>

    <a class="author-card" href="/category/?name=Lauren%20Asher%20Special">
      <div class="author-photo-wrap">
        <img src="/images/lauren-asher-author.jpg" alt="Lauren Asher" loading="lazy" width="172" height="172"/>
      </div>
      <div class="author-card-label">Romance</div>
      <div class="author-card-name">Lauren Asher</div>
      <div class="author-card-cta">View books →</div>
    </a>

    <a class="author-card" href="/category/?name=Ali%20Hazelwood%20Special">
      <div class="author-photo-wrap">
        <img src="/images/ali-hazelwood-author.jpg" alt="Ali Hazelwood" loading="lazy" width="172" height="172"/>
      </div>
      <div class="author-card-label">Romance</div>
      <div class="author-card-name">Ali Hazelwood</div>
      <div class="author-card-cta">View books →</div>
    </a>

    <a class="author-card" href="/category/?name=All%20Romance%20Books">
      <div class="author-photo-wrap">
        <picture>
          <source srcset="/images/elle-kennedy-author.webp" type="image/webp"/>
          <img src="/images/elle-kennedy-author.webp" alt="Elle Kennedy" loading="lazy" width="172" height="172"/>
        </picture>
      </div>
      <div class="author-card-label">Romance</div>
      <div class="author-card-name">Elle Kennedy</div>
      <div class="author-card-cta">View books →</div>
    </a>

    <a class="author-card" href="/category/?name=Robert%20Greene%20Special">
      <div class="author-photo-wrap">
        <picture>
          <source srcset="/images/robert-greene-power-trilogy.webp" type="image/webp"/>
          <img src="/images/robert-greene-power-trilogy.webp" alt="Robert Greene" loading="lazy" width="172" height="172" style="object-position:center center;"/>
        </picture>
      </div>
      <div class="author-card-label">Strategy</div>
      <div class="author-card-name">Robert Greene</div>
      <div class="author-card-cta">View books →</div>
    </a>

    <a class="author-card" href="/category/?name=Akshat%20Gupta%20Books">
      <div class="author-photo-wrap">
        <img src="/.netlify/functions/image-proxy?i=e6d2a8df9059fd77f79ab8ed" alt="Akshat Gupta" loading="lazy" width="172" height="172" style="object-position:center center;"/>
      </div>
      <div class="author-card-label">Mythology</div>
      <div class="author-card-name">Akshat Gupta</div>
      <div class="author-card-cta">View books →</div>
    </a>

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
          💬 <a href="https://wa.me/917678400508" target="_blank" style="color:var(--gold);text-decoration:none;">+91 76784 00508 (WhatsApp)</a>
        </p>
      </div>
    </div>
    <div>
      <div class="footer-col-title">Shop</div>
      <ul class="footer-links">
        <li><a href="/books/">All Books (Full Catalogue)</a></li>
        <li><a href="/self-help-books/">Self-Help Books</a></li>
        <li><a href="/hindi-books/">Hindi Books</a></li>
        <li><a href="/book-combos/">Book Combos</a></li>
        <li><a href="/new-arrivals/">New Arrivals</a></li>
        <li><a href="/bestsellers/">Bestsellers</a></li>
      </ul>
    </div>
    <div>
      <div class="footer-col-title">Company</div>
      <ul class="footer-links">
        <li><a href="/about/">About Us</a></li>
        <li><a href="/contact/">Contact Us</a></li>
        <li><a href="/track/">Track Order</a></li>
        <li><a href="https://wa.me/917678400508" target="_blank">WhatsApp Support</a></li>
        <li><a href="https://www.instagram.com/inkandchai.in/" target="_blank" rel="noopener">Instagram</a></li>
      </ul>
    </div>
    <div>
      <div class="footer-col-title">Help &amp; Policies</div>
      <ul class="footer-links">
        <li><a href="/shipping-policy/">Shipping Policy</a></li>
        <li><a href="/return-policy/">Return Policy</a></li>
        <li><a href="/refund-policy/">Refund Policy</a></li>
        <li><a href="/terms/">Terms &amp; Conditions</a></li>
        <li><a href="/privacy-policy/">Privacy Policy</a></li>
      </ul>
    </div>
  </div>
  <!-- Business identity block — transparency for customers & Google Merchant -->
  <div class="footer-business">
    <span><strong>Ink &amp; Chai</strong> — Online Bookstore</span>
    <span>📧 <a href="mailto:support@inkandchai.in">support@inkandchai.in</a></span>
    <span>📞 <a href="https://wa.me/917678400508">+91 76784 00508</a> · Mon–Fri 9 AM–6 PM IST</span>
    <span>🔒 Secure payments via UPI · Cards · Net Banking · Cash on Delivery</span>
  </div>
  <div class="footer-bottom">
    <span class="footer-copy">© 2026 Ink &amp; Chai · All rights reserved.</span>
    <div class="footer-bottom-links">
      <a href="/about/">About</a>
      <a href="/contact/">Contact</a>
      <a href="/privacy-policy/">Privacy</a>
      <a href="/terms/">Terms</a>
      <a href="mailto:support@inkandchai.in">support@inkandchai.in</a>
    </div>
  </div>
</footer>

<!-- (single floating WhatsApp button is .wa-float, rendered above) -->

<!-- Supabase JS (for user accounts) -->
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
<script>
  window.SUPABASE_URL      = "SUPABASE_URL_PLACEHOLDER";
  window.SUPABASE_ANON_KEY = "SUPABASE_ANON_KEY_PLACEHOLDER";
</script>
<!-- Razorpay SDK -->
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<!-- Razorpay Affordability Widget -->
<script src="https://cdn.razorpay.com/widgets/affordability/affordability.js"></script>
<!-- Razorpay public key (set via env at build time) -->
<script>window.RAZORPAY_KEY_ID = "RAZORPAY_PUB_KEY_PLACEHOLDER";</script>
<!-- Cart, Checkout & Auth -->
<script src="/js/cart.js"></script>
<script src="/js/google-discount.js"></script>
<script src="/js/google-customer-reviews.js"></script>
<script src="/js/checkout.js"></script>
<script src="/js/auth.js"></script>
<script src="/js/search-suggest.js" defer></script>

<script>
// ── DATA ──────────────────────────────────────────────────────────────────
const BOOKS = BOOKS_DATA_PLACEHOLDER;
window.IAC_BOOKS = BOOKS;

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
  if (override.scarcity != null) book.sc = override.scarcity ? 1 : 0;
  // Manual stock: null/absent = in stock; <=0 = sold out ("Coming Soon").
  if (override.stock_qty !== null && override.stock_qty !== undefined) book.stock = override.stock_qty;
  if (override.image_url) book.img = override.image_url;  // cover image override
  // The "Genuine — Publisher Sourced" badge is an admin toggle for every
  // product, not just tag-carrying imports, so a non-null override wins over
  // whatever the tag said. Null = no admin opinion; keep the tag's answer.
  if (override.publisher_sourced != null) book.publisher_sourced = !!override.publisher_sourced;
  // Per-product handling time: extra days before dispatch. Absent = store default.
  if (override.handling_days != null) book.handling_days = override.handling_days;
}
// A book is sold out only when an explicit stock override brought it to 0 or
// below. No override / undefined stock = in stock (the 999 default).
function isSoldOut(book) {
  return book && book.stock !== null && book.stock !== undefined && Number(book.stock) <= 0;
}

function customProductToBook(product) {
  if (!product || !product.slug || !product.title) return null;
  const createdAt = product.created_at || product.updated_at || '';
  const createdTime = Date.parse(createdAt);
  const isNew = Number.isFinite(createdTime) && (Date.now() - createdTime) <= 45 * 86400000;
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
    n: isNew ? 1 : 0,
    ts: createdAt,
    pdf: '',
    pdf_pages: 0,
    rating: '',
    review_count: '',
    order_badge: '',
    review_image: '',
    review_video: '',
    reviews: [],
    custom: true,
    // True when the custom_products row carries the tag emitted by the
    // Crossword-bestseller importer — surfaces the "Genuine, sourced from the
    // publisher" banner on the product page. Cheap string contains so any
    // future tag-driven banners can follow the same pattern.
    publisher_sourced: /publisher-sourced-bestseller/i.test(String(product.tags || '')),
    // Crossword/99bookstores imports are prepaid-only. This has to ride along
    // on the book object or a homepage card can add a no-COD title to the cart
    // without the flag, and checkout will happily offer Cash on Delivery.
    no_cod: /(?:^|,)\s*no-cod\s*(?:,|$)/i.test(String(product.tags || '')),
  };
}

async function loadProductOverrides() {
  try {
    // Honor the endpoint's 5-min Cache-Control (was 'no-store', which forced a
    // fresh ~250 KB fetch on every page view — a major egress drain).
    const res = await fetch('/.netlify/functions/get-product-overrides', { cache: 'default' });
    if (!res.ok) return;
    const data = await res.json();
    const bySlug = new Map((data.overrides || []).map(o => [String(o.slug || '').toLowerCase(), o]));
    window._overrideBySlug = bySlug;  // reused when the full catalogue lazy-loads
    BOOKS.forEach(book => applyProductOverride(book, bySlug.get(String(book.slug || '').toLowerCase())));
    (data.custom_products || []).forEach(product => {
      const book = customProductToBook(product);
      if (book && !BOOKS.some(existing => String(existing.slug || '').toLowerCase() === String(book.slug).toLowerCase())) {
        BOOKS.push(book);
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
  // New arrivals always appear first on All tab
  if ((b.n || 0) !== (a.n || 0)) return (b.n || 0) - (a.n || 0);
  if ((b.n || 0) && (a.n || 0)) {
    const byCreated = Date.parse(b.ts || 0) - Date.parse(a.ts || 0);
    if (byCreated) return byCreated;
  }
  return liveSalesScore(b) - liveSalesScore(a)
    || trendScore(b) - trendScore(a)
    || editionPenalty(a) - editionPenalty(b)
    || a.t.localeCompare(b.t);
}

function liveSalesScore(book) {
  const sales = window.IAC_BESTSELLER_SALES;
  if (!(sales instanceof Map)) return 0;
  const slug = String(book?.slug || '').toLowerCase();
  const title = normalizeSearchText(book?.t || '');
  return Number(sales.get('s:' + slug) || sales.get('t:' + title) || 0);
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // Strip apostrophes so contractions collapse: "Can't" -> "cant", matching a
    // user typing "cant". (Previously these became "can t", so "cant hurt me"
    // matched only 2 of 3 tokens and the 70% threshold rejected every
    // "Can't Hurt Me" listing.) Applied to both query and book titles.
    .replace(/[`’‘´'ʼ]/g, "")
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u0900-\u097f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Common misspellings & Hinglish variants → canonical search tokens
const SEARCH_SYNONYMS = {
  'habbit':'habit','habbits':'habits','atomik':'atomic','atmoic':'atomic',
  'ikigayi':'ikigai','ikigia':'ikigai','ikiga':'ikigai',
  'physcology':'psychology','phychology':'psychology','pyschology':'psychology','psycology':'psychology',
  'freida':'freida','frieda':'freida','mcfadden':'mcfadden','mcfaden':'mcfadden','macfadden':'mcfadden',
  'colen':'colleen','collen':'colleen','coleen':'colleen','hover':'hoover',
  'huang':'huang','hwang':'huang',
  'goggins':'goggins','gogins':'goggins',
  'kiyosaki':'kiyosaki','kiyosak':'kiyosaki','kiosaki':'kiyosaki',
  'milionaire':'millionaire','millionare':'millionaire',
  'sapiens':'sapiens','sapians':'sapiens',
  'manga':'manga','mangaa':'manga',
  'novel':'novel','novle':'novel',
  'hindhi':'hindi','hindii':'hindi',
  'combo':'combo','kombo':'combo',
  'boxset':'box set','boxsets':'box set',
};
function applySynonyms(text) {
  return text.split(' ').map(w => SEARCH_SYNONYMS[w] || w).join(' ');
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
  const q = applySynonyms(normalizeSearchText(rawQuery));
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
  const titleWords  = doc.title.split(' ');
  const authorWords = doc.author.split(' ');
  for (const token of tokens) {
    if (titleWords.some(w => w === token)) { score += 95; matched++; continue; }
    // Prefix hit: typing "atom hab" finds "atomic habits"
    if (token.length >= 3 && titleWords.some(w => w.startsWith(token))) { score += 80; matched++; continue; }
    if (doc.title.includes(token)) { score += 70; matched++; continue; }
    if (token.length >= 3 && authorWords.some(w => w.startsWith(token))) { score += 55; matched++; continue; }
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
  const hasLiveBestsellers = window.IAC_BESTSELLER_SALES instanceof Map
    && window.IAC_BESTSELLER_SALES.size > 0;
  const tabFiltered = BOOKS.filter(b => currentTab === 'All'
    || (currentTab === 'New' && b.n === 1)
    || (currentTab === 'Bestsellers' && (hasLiveBestsellers ? liveSalesScore(b) > 0 : trendScore(b) > 0))
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
    <a class="book-card" href="/product/${b.slug}/" style="text-decoration:none;color:inherit;display:block;">
      <div class="book-cover" style="position:relative;">
        ${b.n ? '<span class="new-badge">NEW</span>' : ''}
        <img src="${b.img}" alt="${escHtml(b.t)}" loading="lazy"
             onerror="this.style.display='none'" />
        <button class="wish-btn ${wishlisted ? 'wishlisted' : ''}"
          data-url="${escHtml(b.url)}"
          title="${wishlisted ? 'Remove from wishlist' : 'Save to wishlist'}"
          onclick="event.preventDefault(); event.stopPropagation(); if(window.toggleWishlist) toggleWishlist({url:'${escHtml(b.url)}',title:'${escHtml(b.t).replace(/'/g,"\\'")}',img:'${escHtml(b.img)}',price:${priceNum}}); updateWishlistBadge();">
          ${wishlisted ? '♥' : '♡'}
        </button>
      </div>
      <div class="book-name">${escHtml(b.t)}</div>
      <div class="book-author">${escHtml(b.a || '')}</div>
      <div class="book-meta">
        <span class="book-price">${escHtml(b.p)}${b.op ? `<span class="book-orig-price">${escHtml(b.op)}</span>` : ''}</span>
        <span class="book-category">${escHtml(b.cat)}</span>
      </div>
      ${isSoldOut(b)
        ? `<span class="btn-add-card" style="opacity:0.65;cursor:not-allowed;color:#e8a030;border-color:rgba(232,160,48,0.4);">Coming Soon</span>`
        : `<button class="btn-add-card" onclick="event.preventDefault(); event.stopPropagation(); addToCartById(this)"
        data-url="${escHtml(b.url)}"
        data-title="${escHtml(b.t)}"
        data-author="${escHtml(b.a||'')}"
        data-price="${priceNum}"
        data-img="${escHtml(b.img)}"
        data-stock="${b.stock ?? ''}"
        data-no-cod="${b.no_cod ? '1' : ''}"
        data-pub-sourced="${b.publisher_sourced ? '1' : ''}"
        data-sku="${escHtml(b.sku||'')}">+ Add to Cart</button>`}
    </a>`;
  }).join('');

  const btn = document.getElementById('loadMoreBtn');
  const info = document.getElementById('booksCount');
  const showing = Math.min(visibleCount, books.length);
  info.textContent = `Showing ${showing} of ${books.length} books`;
  updateSearchStatus(books.length);
  btn.style.display = books.length > visibleCount ? 'inline-block' : 'none';
  btn.onclick = loadMore;
}

// ── Card polish: fade-in covers + staggered scroll reveal (Fable 5) ────────
// A single IntersectionObserver shared across all grid render paths. A
// MutationObserver re-runs the enhancer whenever any grid's contents change,
// so renderBooks / search / category renders are all covered automatically.
let _iacCardObserver = null;
function iacEnhanceCards() {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Fade book covers in as they decode
  document.querySelectorAll('.book-cover img:not([data-iac-img])').forEach(img => {
    img.setAttribute('data-iac-img', '1');
    if (img.complete && img.naturalWidth > 0) { img.classList.add('loaded'); }
    else { img.addEventListener('load', () => img.classList.add('loaded'), { once: true }); }
  });

  if (reduce) { document.querySelectorAll('.book-card:not([data-iac-seen])').forEach(c => c.setAttribute('data-iac-seen','1')); return; }

  if (!_iacCardObserver) {
    _iacCardObserver = new IntersectionObserver((entries) => {
      entries.forEach((e, idx) => {
        if (!e.isIntersecting) return;
        const card = e.target;
        // Stagger within the same observation batch for a gentle cascade
        card.style.animationDelay = Math.min(idx * 45, 320) + 'ms';
        card.classList.add('reveal');
        _iacCardObserver.unobserve(card);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
  }
  document.querySelectorAll('.book-card:not([data-iac-seen])').forEach(card => {
    card.setAttribute('data-iac-seen', '1');
    _iacCardObserver.observe(card);
  });
}
// Watch every books grid for content changes and enhance automatically
document.addEventListener('DOMContentLoaded', () => {
  const grids = ['booksGrid'].map(id => document.getElementById(id)).filter(Boolean);
  grids.forEach(grid => {
    new MutationObserver(() => iacEnhanceCards()).observe(grid, { childList: true });
  });
  iacEnhanceCards();
});

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
    <a class="book-card" href="/product/${b.slug}/" style="text-decoration:none;color:inherit;display:block;">
      <div class="book-cover">
        <img src="${b.img}" alt="${escHtml(b.t)}" loading="lazy" onerror="this.style.display='none'" />
      </div>
      <div class="book-name">${escHtml(b.t)}</div>
      <div class="book-author">${escHtml(b.a || '')}</div>
      <div class="book-meta">
        <span class="book-price">${escHtml(b.p)}${b.op ? `<span class="book-orig-price">${escHtml(b.op)}</span>` : ''}</span>
        <span class="book-category">${escHtml(b.cat)}</span>
      </div>
      <button class="btn-add-card" onclick="event.preventDefault(); event.stopPropagation(); addToCartById(this)"
        data-url="${escHtml(b.url)}"
        data-title="${escHtml(b.t)}"
        data-author="${escHtml(b.a||'')}"
        data-price="${(b.p||'').replace(/[^0-9.]/g,'')}"
        data-stock="${b.stock ?? ''}"
        data-img="${escHtml(b.img)}">+ Add to Cart</button>
    </a>
  `).join('');
  const info = document.getElementById('booksCount');
  if (info) info.textContent = `Showing ${matches.length} books from ${name}`;
  const btn = document.getElementById('loadMoreBtn');
  if (btn) btn.style.display = 'none';
  document.getElementById('featured').scrollIntoView({ behavior: 'smooth' });
}

// Called by Add to Cart buttons — reads data-* attrs from button element
function addToCartById(btn) {
  // Central sold-out guard: any card button carrying data-stock<=0 can't add.
  const st = btn && btn.dataset ? btn.dataset.stock : '';
  if (st !== '' && st !== undefined && st !== null && Number(st) <= 0) {
    if (window.showToast) showToast('Out of stock — Coming Soon');
    return;
  }
  addToCart({
    id:     btn.dataset.url,
    title:  btn.dataset.title,
    author: btn.dataset.author || '',
    price:  parseFloat(btn.dataset.price || '0'),
    img:    btn.dataset.img,
    url:    btn.dataset.url,
    sku:    btn.dataset.sku || '',
    // Matches what /books and the product page put on these items. _no_cod is
    // the one checkout reads to disable Cash on Delivery, so losing it here
    // would let a prepaid-only title be ordered COD.
    ...(btn.dataset.noCod ? { _no_cod: true } : {}),
    ...(btn.dataset.pubSourced ? { _publisher_sourced: true } : {}),
  });
  // Quick visual confirmation on the button itself
  if (btn && !btn._iacBusy) {
    btn._iacBusy = true;
    const original = btn.textContent;
    btn.classList.add('added', 'iac-pop');
    btn.textContent = '✓ Added';
    setTimeout(() => {
      btn.classList.remove('added', 'iac-pop');
      btn.textContent = original;
      btn._iacBusy = false;
    }, 1100);
  }
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

// ── Lazy full-catalogue upgrade ──────────────────────────────────────────────
// The homepage ships only the LITE book subset for a fast first paint, so search
// would otherwise miss most of the ~5k-book catalogue (e.g. "cant hurt me" only
// found the 2 titles in the subset). The moment the user starts searching we
// pull in the full catalogue (books-full-*.js, ~1yr-cached) and merge the extra
// titles into the live BOOKS array, then re-render so results are complete.
let _fullCatState = 'lite';           // 'lite' | 'loading' | 'full'
let _fullCatWaiters = [];
function ensureFullCatalogue(onReady) {
  if (_fullCatState === 'full') { if (onReady) onReady(false); return; }
  if (_fullCatState === 'loading') { if (onReady) _fullCatWaiters.push(onReady); return; }
  const url = window.BOOKS_FULL_URL;
  if (!url) { if (onReady) onReady(false); return; }   // nothing to upgrade to
  _fullCatState = 'loading';
  _fullCatWaiters = onReady ? [onReady] : [];
  const liteRef = window.BOOKS_PRELOAD;                // BOOKS === this array
  const s = document.createElement('script');
  s.src = url;
  s.onload = () => {
    let added = 0;
    try {
      const full = window.BOOKS_PRELOAD;               // full script overwrote the global
      if (Array.isArray(full) && full !== liteRef) {
        const seen = new Set(BOOKS.map(b => String(b.slug || '').toLowerCase()));
        for (const b of full) {
          const slug = String(b.slug || '').toLowerCase();
          if (slug && !seen.has(slug)) {
            BOOKS.push(b); BOOK_MAP[b.slug] = b; seen.add(slug); added++;
            if (window._overrideBySlug) applyProductOverride(b, window._overrideBySlug.get(slug));
          }
        }
      }
      window.BOOKS_PRELOAD = liteRef;                  // keep BOOKS === window.BOOKS_PRELOAD
    } catch (e) { console.warn('[search] full-catalogue merge failed:', e); }
    _fullCatState = 'full';
    console.log('[search] full catalogue ready (+' + added + ' books)');
    const waiters = _fullCatWaiters; _fullCatWaiters = [];
    waiters.forEach(fn => { try { fn(true); } catch (e) {} });
  };
  s.onerror = () => {
    _fullCatState = 'lite';                            // allow a later retry
    const waiters = _fullCatWaiters; _fullCatWaiters = [];
    waiters.forEach(fn => { try { fn(false); } catch (e) {} });
  };
  document.head.appendChild(s);
}
// Re-render whichever search UI is currently showing (called after the full
// catalogue finishes loading so newly-available titles appear without a retype).
function _reRenderSearchAfterLoad() {
  const overlay = document.getElementById('srchOverlay');
  const srchIn  = document.getElementById('srchInput');
  if (overlay && overlay.classList.contains('open') && srchIn) renderSrchResults(srchIn.value || '');
  if (currentQuery) renderBooks();
}

// ── REMOTE CATALOGUE FALLBACK ─────────────────────────────────────────────
// BOOKS only ever holds the ~980 custom products get-product-overrides is
// allowed to ship; the ~19.7k crossword.in + 99bookstores imports are kept out
// of that per-pageview feed on purpose (egress). They were therefore
// unfindable from this search box even though their product pages are live and
// people buy from them. Ask catalog-search for anything the local index can't
// answer and merge the hits into BOOKS, so one search covers the whole shop.
let _catFetchTimer = null;
const _catFetched = new Map();   // normalised query -> true (also caches misses)

function catalogFallbackSearch(rawQuery) {
  const q = String(rawQuery || '').trim();
  if (q.length < 3) return;
  const key = q.toLowerCase();
  if (_catFetched.has(key)) return;
  clearTimeout(_catFetchTimer);
  _catFetchTimer = setTimeout(async () => {
    if (_catFetched.has(key)) return;
    _catFetched.set(key, true);
    try {
      const res = await fetch('/.netlify/functions/catalog-search?per_page=24&q=' + encodeURIComponent(q));
      if (!res.ok) return;
      const data = await res.json();
      const seen = new Set(BOOKS.map(b => String(b.slug || '').toLowerCase()));
      let added = 0;
      for (const r of (data.books || [])) {
        const slug = String(r.slug || '').toLowerCase();
        if (!slug || seen.has(slug)) continue;
        // Re-shape into the custom_products row customProductToBook expects, so
        // there is exactly one book-building path rather than two that drift.
        const book = customProductToBook({
          slug: r.slug,
          title: r.title,
          price_inr: r.price,
          original_price_inr: r.original_price,
          image_url: r.img,
          // catalog-search only serves the publisher-sourced import catalogues,
          // and collapses their tags down to the one no_cod boolean.
          tags: 'publisher-sourced-bestseller' + (r.no_cod ? ',no-cod' : ''),
        });
        if (!book) continue;
        book.ts = '';           // no created_at over the wire; never flag these NEW
        book.n = 0;
        BOOKS.push(book); BOOK_MAP[book.slug] = book; seen.add(slug); added++;
        if (window._overrideBySlug) applyProductOverride(book, window._overrideBySlug.get(slug));
      }
      if (added) _reRenderSearchAfterLoad();
    } catch (err) {
      _catFetched.delete(key);   // transient failure — let the next keystroke retry
    }
  }, 350);
}

function onSearch() {
  ensureFullCatalogue(_reRenderSearchAfterLoad);
  catalogFallbackSearch(document.getElementById('searchInput')?.value || '');
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
  ensureFullCatalogue(_reRenderSearchAfterLoad);  // upgrade to full catalogue on open
  // Sync current search value into overlay input
  const mainVal = document.getElementById('searchInput')?.value || '';
  const srchIn  = document.getElementById('srchInput');
  if (srchIn) srchIn.value = mainVal;
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  renderSrchResults(srchIn?.value || '');
  setTimeout(() => srchIn?.focus(), 60);
}

function closeSiteSearch() {
  document.getElementById('srchOverlay')?.classList.remove('open');
  document.body.style.overflow = '';
}
// Press "/" anywhere to open search (like GitHub/YouTube)
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  e.preventDefault();
  focusSiteSearch();
});

// Deep-link: /?q=<query> opens the search overlay pre-filled with that query.
// Used by the product-detail page nav search (product-page.js has no client
// BOOKS array, so it hands off the query to the homepage's full-catalogue search).
(function(){
  const q = (new URLSearchParams(location.search).get('q') || '').trim();
  if (!q) return;
  function run(){
    const mainIn = document.getElementById('searchInput');
    if (mainIn) mainIn.value = q;
    if (typeof ensureFullCatalogue === 'function') ensureFullCatalogue(_reRenderSearchAfterLoad);
    if (typeof focusSiteSearch === 'function') focusSiteSearch();
    const srchIn = document.getElementById('srchInput');
    if (srchIn) srchIn.value = q;
    if (typeof renderSrchResults === 'function') renderSrchResults(q);
  }
  // Run once the DOM is ready, then again after the async catalogue (BOOKS)
  // finishes loading so results are complete even on a cold load.
  const kick = () => { run(); setTimeout(run, 700); setTimeout(run, 1600); };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', kick);
  else kick();
})();

// ── Touch/mobile nav dropdowns ───────────────────────────────────────────────
// The Categories/Policies menus open on :hover on desktop, but touch devices
// have no hover — the trigger is a plain <a> that would just navigate. On touch
// (or narrow widths), the first tap opens the menu instead; tapping outside or
// another trigger closes it. The dropdown is positioned fixed while open so the
// mobile nav's horizontal-scroll (overflow) can't clip it.
(function(){
  const menus = [...document.querySelectorAll('.nav-dropdown-menu')];
  if (!menus.length) return;
  const isTouch = () => window.matchMedia('(hover: none), (pointer: coarse), (max-width: 780px)').matches;

  function place(menu){
    const dd = menu.querySelector('.nav-dropdown'); if (!dd) return;
    const r = menu.getBoundingClientRect();
    dd.style.position = 'fixed';
    dd.style.top = Math.round(r.bottom + 6) + 'px';
    dd.style.left = '50%';
    dd.style.right = 'auto';
    dd.style.maxWidth = 'min(360px, 92vw)';
  }
  function clear(menu){
    const dd = menu.querySelector('.nav-dropdown'); if (!dd) return;
    ['position','top','left','right','maxWidth'].forEach(p => dd.style[p] = '');
  }
  function closeAll(except){
    menus.forEach(m => { if (m !== except && m.classList.contains('open')) { m.classList.remove('open'); clear(m); } });
  }
  menus.forEach(menu => {
    const trig = menu.querySelector('.nav-dropdown-trigger');
    if (!trig) return;
    trig.addEventListener('click', (e) => {
      if (!isTouch()) return;                 // desktop keeps pure hover behaviour
      if (!menu.classList.contains('open')) {
        e.preventDefault();                   // first tap opens instead of navigating
        closeAll(menu);
        menu.classList.add('open');
        place(menu);
      }
      // a second tap on the trigger falls through and follows the link
    });
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.nav-dropdown-menu')) closeAll(null); });
  window.addEventListener('resize', () => closeAll(null));
})();

let _srchSel = -1;
function srchType() {
  ensureFullCatalogue(_reRenderSearchAfterLoad);  // upgrade to full catalogue as they type
  const val = document.getElementById('srchInput')?.value || '';
  catalogFallbackSearch(val);
  const mainInput = document.getElementById('searchInput');
  if (mainInput) mainInput.value = val;
  currentQuery = val;
  visibleCount = PAGE_SIZE;
  renderBooks();
  renderSrchResults(val);
}

function highlightMatch(text, query) {
  const t = escHtml(text);
  const tokens = normalizeSearchText(query).split(' ').filter(w => w.length >= 2);
  if (!tokens.length) return t;
  try {
    const re = new RegExp('(' + tokens.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
    return t.replace(re, '<mark>$1</mark>');
  } catch(e) { return t; }
}

function renderSrchResults(query) {
  const box = document.getElementById('srchResults');
  if (!box) return;
  _srchSel = -1;
  const q = (query || '').trim();
  if (q.length < 2) { box.classList.remove('has'); box.innerHTML = ''; return; }
  const matches = BOOKS.map(b => ({ b, score: searchScore(b, q) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(x => x.b);
  if (!matches.length) {
    box.innerHTML = '<div style="padding:1.1rem;text-align:center;font-size:0.74rem;color:var(--cream-dim);">No matches — try fewer words or a different spelling.</div>';
    box.classList.add('has');
    return;
  }
  const total = BOOKS.filter(b => searchScore(b, q) > 0).length;
  box.innerHTML = matches.map(b => `
    <a class="srch-hit" href="/product/${b.slug}/" role="option">
      <div class="srch-hit-img">${b.img ? `<img src="${b.img}" alt="" loading="lazy" onerror="this.style.display='none'"/>` : ''}</div>
      <div class="srch-hit-info">
        <div class="srch-hit-title">${highlightMatch(b.t, q)}</div>
        <div class="srch-hit-author">${escHtml(b.a || '')}${b.cat ? ' · ' + escHtml(b.cat) : ''}</div>
      </div>
      <div class="srch-hit-price">${escHtml(b.p || '')}</div>
    </a>`).join('')
    + (total > matches.length ? `<button class="srch-all" onclick="srchShowAll()">View all ${total} results ↓</button>` : '');
  box.classList.add('has');
}

function srchShowAll() {
  closeSiteSearch();
  document.getElementById('featured')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function srchMove(delta) {
  const hits = Array.from(document.querySelectorAll('#srchResults .srch-hit'));
  if (!hits.length) return false;
  _srchSel = Math.max(0, Math.min(hits.length - 1, _srchSel + delta));
  hits.forEach((h, i) => h.classList.toggle('sel', i === _srchSel));
  hits[_srchSel].scrollIntoView({ block: 'nearest' });
  return true;
}

function srchKey(e) {
  if (e.key === 'Escape') { closeSiteSearch(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); srchMove(1); return; }
  if (e.key === 'ArrowUp')   { e.preventDefault(); srchMove(-1); return; }
  if (e.key === 'Enter' && _srchSel >= 0) {
    const sel = document.querySelectorAll('#srchResults .srch-hit')[_srchSel];
    if (sel) { location.href = sel.getAttribute('href'); return; }
  }
  if (e.key === 'Enter') {
    // Track search query for recommendation personalisation
    const q = (document.getElementById('srchInput')?.value || '').trim();
    if (q.length > 2) {
      try {
        const prev = JSON.parse(localStorage.getItem('iac_searches') || '[]');
        const updated = [...prev.filter(s => s !== q), q].slice(-20);
        localStorage.setItem('iac_searches', JSON.stringify(updated));
      } catch(e) {}
    }
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
    return `<a class="shelf-card" href="/product/${b.slug}/" style="text-decoration:none;color:inherit;display:block;">
      <div class="shelf-card-cover">
        <img src="${b.img}" alt="${escHtml(b.t)}" loading="lazy" onerror="this.style.display='none'" />
      </div>
      <div class="shelf-card-name">${escHtml(b.t)}</div>
      <div class="shelf-card-price">${escHtml(b.p)}</div>
      <button class="shelf-card-btn" onclick="event.preventDefault(); event.stopPropagation(); addToCartById(this)"
        data-url="${escHtml(b.url)}" data-title="${escHtml(b.t)}"
        data-author="${escHtml(b.a||'')}" data-price="${price}"
        data-stock="${b.stock ?? ''}"
        data-img="${escHtml(b.img)}" data-sku="${escHtml(b.sku||'')}">+ Add to Cart</button>
    </a>`;
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
    <a class="book-card" href="/product/${b.slug}/" style="text-decoration:none;color:inherit;display:block;">
      <div class="book-cover" style="position:relative;">
        ${b.n ? '<span class="new-badge">NEW</span>' : ''}
        <img src="${b.img}" alt="${escHtml(b.t)}" loading="lazy" onerror="this.style.display='none'" />
      </div>
      <div class="book-name">${escHtml(b.t)}</div>
      <div class="book-author">${escHtml(b.a || '')}</div>
      <div class="book-meta">
        <span class="book-price">${escHtml(b.p)}${b.op ? `<span class="book-orig-price">${escHtml(b.op)}</span>` : ''}</span>
        <span class="book-category">${escHtml(b.cat)}</span>
      </div>
      <button class="btn-add-card" onclick="event.preventDefault(); event.stopPropagation(); addToCartById(this)"
        data-url="${escHtml(b.url)}"
        data-title="${escHtml(b.t)}"
        data-author="${escHtml(b.a||'')}"
        data-price="${(b.p||'').replace(/[^0-9.]/g,'')}"
        data-stock="${b.stock ?? ''}"
        data-img="${escHtml(b.img)}">+ Add to Cart</button>
    </a>
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
          style="font-size:0.58rem;letter-spacing:0.18em;text-transform:uppercase;padding:0.5rem 0.9rem;background:#c9a84c;color:#0d0b08;border:none;cursor:pointer;font-family:'Inter',sans-serif;">
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
  const sb = window.supabase && window.SUPABASE_URL !== ('SUPABASE_URL'+'_PLACEHOLDER')
    ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY) : null;
  if (sb) sb.from('newsletter').insert({ email }).then(() => {});
  msg.style.color = '#6dbf6d';
  msg.textContent = '✓ You\'re subscribed! Expect our first newsletter soon.';
  document.getElementById('nlEmail').value = '';
}

// ── FREEDOM SALE COUNTDOWN ────────────────────────────────────────────────
const SALE_END_DATE = new Date('2026-08-15T18:29:59Z'); // 11:59:59 PM IST Aug 15

function formatCountdown(diff) {
  if (diff <= 0) return null;
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return { d, h: String(h).padStart(2,'0'), m: String(m).padStart(2,'0'), s: String(s).padStart(2,'0') };
}

// Every surface that advertises the sale, removed together. The old code
// removed only #summerSale, so when the sale ended the top bar kept promising
// "15% OFF ... Automatically applied" with a blank countdown while checkout
// refused the code. Anything added that mentions the sale belongs in here AND
// in a SALE:START/SALE:END marker pair.
function removeExpiredSaleSurfaces() {
  document.getElementById('promoBanner')?.remove();
  document.getElementById('summerSale')?.remove();
  const carousel = document.getElementById('promoCarousel');
  const slide = carousel?.querySelector('.promo-slide.slide-sale');
  if (slide) {
    // The dot at the same index belongs to this slide; drop it too or the
    // carousel shows a dot that navigates to nothing.
    const slides = [...carousel.querySelectorAll('.promo-slide')];
    const dots = [...carousel.querySelectorAll('.promo-dot')];
    dots[slides.indexOf(slide)]?.remove();
    slide.remove();
    // Whatever was showing may have just been removed; hand "active" to the
    // first slide that survived.
    if (!carousel.querySelector('.promo-slide.active')) {
      carousel.querySelector('.promo-slide')?.classList.add('active');
      carousel.querySelector('.promo-dot')?.classList.add('active');
    }
  }
}

function updateSaleCountdown() {
  const diff = SALE_END_DATE.getTime() - Date.now();
  const t = formatCountdown(diff);

  // Big banner countdown (standalone section)
  const big = document.getElementById('saleCountdown');
  if (big) {
    if (!t) { removeExpiredSaleSurfaces(); return; }
    big.innerHTML =
      `<div class="cd-block"><span class="cd-num">${t.d}</span><span class="cd-label">Days</span></div>` +
      `<span class="cd-sep">:</span>` +
      `<div class="cd-block"><span class="cd-num">${t.h}</span><span class="cd-label">Hours</span></div>` +
      `<span class="cd-sep">:</span>` +
      `<div class="cd-block"><span class="cd-num">${t.m}</span><span class="cd-label">Mins</span></div>` +
      `<span class="cd-sep">:</span>` +
      `<div class="cd-block"><span class="cd-num">${t.s}</span><span class="cd-label">Secs</span></div>`;
  }
  // Hero carousel sale slide countdown
  const heroCountdown = document.getElementById('saleCountdownHero');
  if (heroCountdown && t) {
    heroCountdown.innerHTML =
      `<div style="display:flex;gap:0.5rem;align-items:flex-start;">` +
      `<div class="cd-block" style="background:rgba(255,255,255,0.1);border-color:rgba(255,255,255,0.25);"><span class="cd-num">${t.d}</span><span class="cd-label">Days</span></div>` +
      `<span class="cd-sep" style="color:rgba(255,255,255,0.4);">:</span>` +
      `<div class="cd-block" style="background:rgba(255,255,255,0.1);border-color:rgba(255,255,255,0.25);"><span class="cd-num">${t.h}</span><span class="cd-label">Hrs</span></div>` +
      `<span class="cd-sep" style="color:rgba(255,255,255,0.4);">:</span>` +
      `<div class="cd-block" style="background:rgba(255,255,255,0.1);border-color:rgba(255,255,255,0.25);"><span class="cd-num">${t.m}</span><span class="cd-label">Min</span></div>` +
      `<span class="cd-sep" style="color:rgba(255,255,255,0.4);">:</span>` +
      `<div class="cd-block" style="background:rgba(255,255,255,0.1);border-color:rgba(255,255,255,0.25);"><span class="cd-num">${t.s}</span><span class="cd-label">Sec</span></div>` +
      `</div>`;
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
  removeExpiredSaleSurfaces();
}

// ── PROMO CAROUSEL ────────────────────────────────────────────────────────
(function() {
  const carousel = document.getElementById('promoCarousel');
  if (!carousel) return;
  const slides = carousel.querySelectorAll('.promo-slide');
  const dots   = carousel.querySelectorAll('.promo-dot');
  if (!slides.length) return;
  // The slide marked active in the markup is the sale slide, and it is removed
  // once the sale ends -- at build time or by the timer above. Without this the
  // carousel would start with nothing showing.
  let cur = Math.max(0, [...slides].findIndex(s => s.classList.contains('active')));
  if (!carousel.querySelector('.promo-slide.active')) {
    slides[0].classList.add('active');
    dots[0]?.classList.add('active');
  }
  let timer;

  function goTo(n) {
    slides[cur].classList.remove('active');
    dots[cur].classList.remove('active');
    cur = ((n % slides.length) + slides.length) % slides.length;
    slides[cur].classList.add('active');
    dots[cur].classList.add('active');
  }
  function startTimer() { timer = setInterval(() => goTo(cur + 1), 6000); }
  function resetTimer() { clearInterval(timer); startTimer(); }

  carousel.querySelector('.promo-arrow.prev')?.addEventListener('click', () => { goTo(cur - 1); resetTimer(); });
  carousel.querySelector('.promo-arrow.next')?.addEventListener('click', () => { goTo(cur + 1); resetTimer(); });
  dots.forEach((d, i) => d.addEventListener('click', () => { goTo(i); resetTimer(); }));

  // Touch/swipe support
  let tx = 0;
  carousel.addEventListener('touchstart', e => { tx = e.touches[0].clientX; }, {passive:true});
  carousel.addEventListener('touchend',   e => {
    const dx = e.changedTouches[0].clientX - tx;
    if (Math.abs(dx) > 40) { goTo(dx < 0 ? cur + 1 : cur - 1); resetTimer(); }
  }, {passive:true});

  startTimer();
})();

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
<script src="/js/homepage-merchandising.js?v=20260729" defer></script>
</body>
</html>
"""

# ── Sale surfaces expire on their own ────────────────────────────────────────
# The Freedom Sale ended on 15 Aug 2026 and the homepage went on advertising
# "15% OFF ... Automatically applied" for a fortnight afterwards, with a dead
# countdown, while checkout correctly refused the code. Customers were promised
# a discount the till would not honour.
#
# The cause was that only ONE of the four sale surfaces knew how to remove
# itself. So the date now lives in exactly one place and every surface is
# wrapped in SALE:START/SALE:END markers: when the sale is over the build ships
# none of them, and the client-side timer strips any that a cached page still
# carries. Adding a surface without a marker is the mistake to avoid -- the
# marker is what makes it disappear.
SALE_END_ISO = '2026-08-15T18:29:59Z'

def sale_is_live(now=None):
    """True while the sale in SALE_END_ISO is still running."""
    from datetime import datetime, timezone
    end = datetime.strptime(SALE_END_ISO, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
    return (now or datetime.now(timezone.utc)) <= end

def strip_expired_sale(html, now=None):
    """Remove every SALE:START..SALE:END region once the sale has ended."""
    if sale_is_live(now):
        return html
    return re.sub(r'<!--SALE:START-->.*?<!--SALE:END-->', '', html, flags=re.S)

HTML = strip_expired_sale(HTML)

# ── Inject real data ─────────────────────────────────────────────────────────
import os
# Start fetching the books preload early so Add-to-Cart works the moment the
# user sees the page (instead of waiting for the late <script> tag).
HTML = HTML.replace("</title>", f"</title>\n{BOOKS_LITE_PRELOAD}", 1)
HTML = HTML.replace("BOOKS_DATA_PLACEHOLDER",         "window.BOOKS_PRELOAD||[]")
# The homepage ships the LITE book subset for a fast first paint. Expose the
# FULL catalogue URL so search can lazily upgrade to the complete ~5k-book set
# the moment the user starts searching (see ensureFullCatalogue() in the JS).
HTML = HTML.replace('<script>\n// ── DATA',
                    f'{BOOKS_LITE_TAG}\n<script>window.BOOKS_FULL_URL="/js/{_books_full_file}";</script>\n\n<script>\n// ── DATA',
                    1)  # inject external data script immediately before main data code
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
<link href="FONT_GOOGLE_URL_SIMPLE_PLACEHOLDER" rel="stylesheet"/>
<script>
  (function(){ var d = document.documentElement; try { if (localStorage.getItem('iac_theme') !== 'dark') d.setAttribute('data-theme','light'); } catch(e){ d.setAttribute('data-theme','light'); /* light default */ } })();
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
html[data-theme="light"]{--bg:#faf7f2;--bg2:#f3ece0;--bg3:#ffffff;--gold:#7a5a12;--gold-light:#5f4610;--gold-dim:#6a4f10;--cream:#241c14;--cream-dim:#4e4032;--muted:#4e4032;--white:#0d0b08;--border:rgba(138,106,31,0.28)}
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
body{background:var(--bg);color:var(--cream);font-family:'Inter',sans-serif;font-weight:400;min-height:100vh}

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
.btn-nav{font-family:'Inter',sans-serif;font-size:0.62rem;letter-spacing:0.22em;text-transform:uppercase;padding:0.55rem 1.4rem;border:1px solid var(--gold-dim);color:var(--gold);background:transparent;cursor:pointer;transition:all 0.3s;text-decoration:none}
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
  /* The bar is fixed, so without this the last thing on the page sits under it
     -- which was the bundle's "+ Add Bundle to Cart" button, unreachable. */
  body{padding-bottom:calc(5.75rem + env(safe-area-inset-bottom,0px))!important}
  .mob-nav{display:none!important}
  #authNavBtnProd{display:inline-flex!important}
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
.btn-sample-pdf{display:inline-flex;align-items:center;gap:0.6rem;font-family:'Inter',sans-serif;font-size:0.62rem;letter-spacing:0.18em;text-transform:uppercase;padding:0.7rem 1.2rem;background:rgba(201,168,76,0.08);color:var(--gold);border:1px dashed rgba(201,168,76,0.45);cursor:pointer;font-weight:500;transition:all 0.2s;text-decoration:none}
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
.pdf-modal-actions a,.pdf-modal-actions button{font-family:'Inter',sans-serif;font-size:0.55rem;letter-spacing:0.18em;text-transform:uppercase;padding:0.5rem 0.9rem;background:transparent;color:var(--cream-dim);border:1px solid var(--border);cursor:pointer;text-decoration:none;transition:all 0.2s}
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
/* Ship-by widget */
.ship-by-box{display:flex;align-items:flex-start;gap:0.65rem;padding:0.75rem 1rem;background:rgba(109,191,109,0.07);border:1px solid rgba(109,191,109,0.22);border-radius:2px}
.ship-by-icon{font-size:1.15rem;line-height:1;flex-shrink:0;margin-top:0.1rem}
.ship-by-text{display:flex;flex-direction:column;gap:0.18rem}
.ship-by-label{font-size:0.58rem;letter-spacing:0.2em;text-transform:uppercase;color:#6dbf6d}
.ship-by-date{font-size:0.95rem;font-weight:600;color:#faf7f2;font-family:'Cormorant Garamond',serif}
.ship-by-sub{font-size:0.62rem;color:#a09080;margin-top:0.1rem}
.ship-by-limited{font-size:0.58rem;letter-spacing:0.15em;text-transform:uppercase;color:#c9a84c;margin-top:0.15rem}
.eta-block{margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid rgba(109,191,109,0.18)}
.eta-head{font-size:0.55rem;letter-spacing:0.2em;text-transform:uppercase;color:#6dbf6d;margin-bottom:0.28rem}
.eta-row{display:flex;justify-content:space-between;gap:1.2rem;font-size:0.66rem;line-height:1.75;color:#a09080}
.eta-pin-row{display:flex;gap:0.4rem;margin:0.35rem 0 0.25rem}.eta-pin-input{flex:1;min-width:0;padding:0.4rem 0.55rem;font-size:0.72rem;letter-spacing:0.06em;color:#f0e8d8;background:rgba(0,0,0,0.18);border:1px solid rgba(109,191,109,0.28);border-radius:8px}.eta-pin-input:focus{outline:none;border-color:#6dbf6d}.eta-pin-btn{padding:0.4rem 0.7rem;font-size:0.6rem;letter-spacing:0.14em;color:#0d0b08;background:#6dbf6d;border:0;border-radius:8px;cursor:pointer}.eta-pin-btn:hover{opacity:0.88}.eta-pin-result{font-size:0.7rem;line-height:1.65;color:#a09080;min-height:1rem}.eta-pin-date strong{color:#f0e8d8;font-weight:600}.eta-pin-place{opacity:0.8}.eta-pin-cod{margin-top:0.1rem;opacity:0.85}.eta-pin-error{color:#e0a060}.eta-pin-loading{opacity:0.7}.eta-pin-geo{margin:0 0 0.3rem;padding:0.3rem 0;font-size:0.64rem;letter-spacing:0.06em;color:#6dbf6d;background:none;border:0;cursor:pointer;text-align:left}.eta-pin-geo:hover{text-decoration:underline}.eta-pin-geo:disabled{opacity:0.5;cursor:default;text-decoration:none}
.eta-zone{white-space:nowrap}
.eta-date{color:#f0e8d8;font-weight:600;white-space:nowrap}
/* Courier partners */
.prod-courier-row{display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap}
.prod-courier-label{font-size:0.58rem;letter-spacing:0.2em;text-transform:uppercase;color:#a09080;flex-shrink:0}
.prod-courier-logos{display:flex;gap:0.4rem;flex-wrap:wrap}
.prod-courier-tag{font-size:0.6rem;letter-spacing:0.1em;padding:0.25rem 0.6rem;border:1px solid rgba(201,168,76,0.2);color:#c9a84c;background:rgba(201,168,76,0.05);border-radius:2px;white-space:nowrap}
/* Scarcity / urgency badge */
.prod-scarcity{display:inline-flex;align-items:center;gap:0.5rem;margin:0.6rem 0 0.2rem;padding:0.45rem 0.85rem;background:rgba(220,60,40,0.1);border:1px solid rgba(220,60,40,0.3);border-radius:2px;font-size:0.73rem;color:#f07060;letter-spacing:0.04em}
.scarcity-dot{width:7px;height:7px;border-radius:50%;background:#e05040;box-shadow:0 0 0 3px rgba(220,60,40,0.25);animation:scarcity-pulse 1.5s ease-in-out infinite}
@keyframes scarcity-pulse{0%,100%{box-shadow:0 0 0 3px rgba(220,60,40,0.25)}50%{box-shadow:0 0 0 6px rgba(220,60,40,0.08)}}
/* Delivery guarantee */
.prod-refund-guarantee{font-size:0.72rem;line-height:1.6;color:#f0e8d8;padding:0.65rem 0.9rem;background:rgba(109,191,109,0.06);border-left:3px solid #6dbf6d}
.prod-desc-title{font-size:0.6rem;letter-spacing:0.3em;text-transform:uppercase;color:var(--gold);margin-bottom:0.6rem}
.prod-desc{font-size:0.95rem;color:var(--cream);line-height:1.85;letter-spacing:0.01em;font-family:var(--font-serif)}
.prod-meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:0.8rem 2rem}
.prod-meta-item{}
.prod-meta-label{font-size:0.55rem;letter-spacing:0.25em;text-transform:uppercase;color:var(--gold-dim);margin-bottom:0.2rem}
.prod-meta-val{font-size:0.78rem;color:var(--cream)}

/* Instagram trust button */
.insta-trust-btn{display:flex;align-items:center;gap:.75rem;padding:.65rem .85rem;margin:.4rem 0 .2rem;background:linear-gradient(135deg,rgba(131,58,180,.08),rgba(253,29,29,.06),rgba(252,176,69,.08));border:1px solid rgba(195,80,170,.25);border-radius:3px;text-decoration:none;color:inherit;transition:border-color .2s,background .2s;cursor:pointer}
.insta-trust-btn:hover{border-color:rgba(195,80,170,.55);background:linear-gradient(135deg,rgba(131,58,180,.14),rgba(253,29,29,.1),rgba(252,176,69,.12))}
.insta-trust-btn-icon{font-size:1.25rem;flex-shrink:0}
.insta-trust-btn-body{display:flex;flex-direction:column;gap:.1rem;flex:1;min-width:0}
.insta-trust-btn-title{font-size:.72rem;font-weight:600;color:var(--cream);letter-spacing:.01em}
.insta-trust-btn-sub{font-size:.58rem;color:var(--cream-dim);letter-spacing:.03em}
.insta-trust-btn-arrow{font-size:.9rem;color:rgba(195,80,170,.7);flex-shrink:0}
.pdp-cred{display:flex;flex-wrap:wrap;gap:.4rem;margin:.6rem 0 .3rem}
.cred-chip{display:inline-flex;align-items:center;gap:.35rem;font-size:.62rem;font-weight:600;letter-spacing:.02em;padding:.34rem .62rem;border:1px solid var(--border);border-radius:999px;color:var(--cream);background:rgba(255,255,255,.02)}
.cred-chip svg{flex-shrink:0}
.cred-meta{border-color:rgba(24,119,242,.45);background:rgba(24,119,242,.1)}
.meta-verified{display:block;margin:.6rem 0 .3rem;border:1px solid var(--border);border-radius:8px;overflow:hidden;text-decoration:none;background:#fff;max-width:420px}
.meta-verified img{display:block;width:100%;height:auto}
.meta-verified-cap{display:flex;align-items:center;gap:.4rem;padding:.5rem .75rem;font-size:.68rem;font-weight:600;letter-spacing:.02em;color:#fff;background:#1877F2}

/* ACTIONS */
.prod-actions{display:flex;flex-direction:column;gap:0.8rem;margin-top:0.5rem}
.btn-cart{width:100%;font-family:'Inter',sans-serif;font-size:0.65rem;letter-spacing:0.25em;text-transform:uppercase;padding:1.1rem;background:var(--gold);color:var(--bg);border:none;cursor:pointer;font-weight:500;transition:all 0.3s}
.btn-cart:hover{background:var(--gold-light);transform:translateY(-1px);box-shadow:0 8px 24px rgba(201,168,76,0.25)}
.btn-cod{width:100%;font-family:'Inter',sans-serif;font-size:0.65rem;letter-spacing:0.25em;text-transform:uppercase;padding:1.1rem;background:rgba(201,168,76,0.12);color:var(--gold);border:1px solid var(--gold-dim);cursor:pointer;font-weight:500;transition:all 0.3s}
.btn-cod:hover{background:var(--gold);color:var(--bg);transform:translateY(-1px);box-shadow:0 8px 24px rgba(201,168,76,0.2)}
.btn-cart.is-loading,.btn-cod.is-loading,.pbb-cart.is-loading,.pbb-buy.is-loading{position:relative;pointer-events:none;opacity:0.78;color:transparent!important}
.btn-cart.is-loading::after,.btn-cod.is-loading::after,.pbb-cart.is-loading::after,.pbb-buy.is-loading::after{content:'';position:absolute;left:50%;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spinBtn .75s linear infinite;color:var(--bg)}
.btn-cod.is-loading::after,.pbb-cart.is-loading::after{color:var(--gold)}
@keyframes spinBtn{to{transform:rotate(360deg)}}
.btn-share{font-size:0.6rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--cream-dim);background:none;border:none;cursor:pointer;display:flex;align-items:center;gap:0.4rem;transition:color 0.2s;font-family:'Inter',sans-serif}
.btn-share:hover{color:var(--gold)}

/* MOBILE BOTTOM BAR */
.prod-bottom-bar{display:none;position:fixed;bottom:0;left:0;right:0;z-index:9999;background:rgba(13,11,8,0.98);border-top:1px solid rgba(201,168,76,0.3);padding:0.75rem 1rem calc(0.75rem + env(safe-area-inset-bottom,0px));gap:0.6rem;align-items:center;backdrop-filter:blur(16px);box-shadow:0 -8px 24px rgba(0,0,0,0.5)}
.pbb-cart{flex:1;font-family:'Inter',sans-serif;font-size:0.6rem;letter-spacing:0.18em;text-transform:uppercase;padding:0.9rem 0.5rem;background:rgba(201,168,76,0.12);color:var(--gold);border:1px solid rgba(201,168,76,0.4);cursor:pointer;font-weight:500;transition:all 0.2s}
.pbb-buy{flex:1.5;font-family:'Inter',sans-serif;font-size:0.63rem;letter-spacing:0.18em;text-transform:uppercase;padding:0.9rem 0.5rem;background:var(--gold);color:var(--bg);border:none;cursor:pointer;font-weight:700;transition:all 0.2s}
.pbb-cart:active{background:var(--gold);color:var(--bg)}
.pbb-buy:active{background:var(--gold-light)}

/* QUANTITY SELECTOR */
.qty-row{display:flex;align-items:center;gap:1rem;margin-top:0.2rem}
.qty-label{font-size:0.57rem;letter-spacing:0.22em;text-transform:uppercase;color:var(--gold-dim)}
.qty-ctrl{display:flex;align-items:center}
.qty-ctrl button{width:36px;height:36px;background:var(--bg2);border:1px solid var(--border);color:var(--cream);font-size:1.15rem;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:border-color 0.2s,color 0.2s}
.qty-ctrl button:hover{border-color:var(--gold);color:var(--gold)}
.qty-num{width:46px;height:36px;display:flex;align-items:center;justify-content:center;border-top:1px solid var(--border);border-bottom:1px solid var(--border);font-size:0.95rem;color:var(--cream);font-family:'Inter',sans-serif;user-select:none}

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
.review-media{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:0.8rem}
.review-media figure{margin:0;border:1px solid rgba(201,168,76,0.22);background:rgba(0,0,0,0.18);overflow:hidden}
.review-media img,.review-media video{width:100%;height:220px;object-fit:cover;display:block;background:#090704}
.review-media figcaption{padding:0.65rem 0.75rem;font-size:0.62rem;color:var(--cream-dim);letter-spacing:0.09em;line-height:1.5}
.review-note{font-size:0.74rem;color:var(--cream-dim);line-height:1.7;margin-top:0.9rem}
@media(max-width:720px){.review-head{display:block}.review-score{text-align:left;margin-top:0.7rem}.review-media{grid-template-columns:1fr}.review-media img,.review-media video{height:auto;max-height:360px;object-fit:contain}}

/* LIVE CUSTOMER REVIEWS */
.live-reviews-section{margin-top:1.2rem;border-top:1px solid var(--border);padding-top:1.2rem}
.live-reviews-head{display:flex;align-items:center;gap:.75rem;margin-bottom:1rem}
.live-reviews-title{font-size:.6rem;letter-spacing:.22em;text-transform:uppercase;color:var(--gold)}
.live-reviews-badge{font-size:.55rem;letter-spacing:.1em;color:var(--cream-dim);background:var(--bg3);border:1px solid var(--border);padding:.2rem .55rem}
.live-review-card{background:var(--bg3);border:1px solid var(--border);padding:1rem 1.1rem;margin-bottom:.6rem}
.live-review-top{display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-bottom:.4rem}
.live-review-stars{color:#f0c040;font-size:.9rem;letter-spacing:.05rem}
.live-review-date{font-size:.56rem;color:var(--cream-dim);letter-spacing:.06em}
.live-review-name{font-size:.68rem;font-weight:600;color:var(--cream);margin-bottom:.35rem}
.live-review-body{font-size:.72rem;color:var(--cream-dim);line-height:1.7}
.live-review-verified{font-size:.52rem;letter-spacing:.12em;text-transform:uppercase;color:#5d9b55;margin-top:.4rem}

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
.fbt-cta{font-family:'Inter',sans-serif;font-size:0.62rem;letter-spacing:0.22em;text-transform:uppercase;padding:0.95rem 1.6rem;background:var(--gold);color:var(--bg);border:none;cursor:pointer;font-weight:600;transition:all 0.25s}
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
.rel-card{cursor:pointer;transition:transform 0.2s,border-color 0.2s;border:1px solid transparent;color:inherit;touch-action:manipulation}
@media(hover:hover){.rel-card:hover{transform:translateY(-3px)}.rel-card:hover .rel-cover{border-color:rgba(201,168,76,0.55)}}
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
.btn-checkout{width:100%;font-family:'Inter',sans-serif;font-size:0.65rem;letter-spacing:0.25em;text-transform:uppercase;padding:1rem;background:var(--gold);color:var(--bg);border:none;cursor:pointer;font-weight:500;transition:all 0.3s}
.btn-checkout:hover{background:var(--gold-light)}

/* NOT FOUND */
.not-found{text-align:center;padding:8rem 2rem;color:var(--cream-dim)}
.not-found h2{font-family:'Cormorant Garamond',serif;font-size:2rem;color:var(--white);margin-bottom:1rem}

/* Promo banner */
.promo-banner{background:linear-gradient(90deg,#1a1410,#2a1f15,#1a1410);border-bottom:1px solid rgba(201,168,76,0.25);padding:0.55rem 1rem;text-align:center;font-size:0.66rem;letter-spacing:0.12em;color:#f0e8d8;font-family:'Inter',sans-serif;position:relative;z-index:200}
.promo-banner strong{color:#c9a84c;font-weight:600;letter-spacing:0.18em}
.promo-banner code{background:rgba(201,168,76,0.18);color:#c9a84c;padding:0.15rem 0.55rem;border:1px dashed rgba(201,168,76,0.5);font-family:'Inter',sans-serif;font-size:0.62rem;letter-spacing:0.15em;margin-left:0.5rem}
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
<a class="wa-float" href="https://wa.me/917678400508?text=Hi%20Ink%20%26%20Chai%2C%20I%20have%20a%20question%20about%20a%20book." target="_blank" rel="noopener" title="Chat with us on WhatsApp" aria-label="WhatsApp support">
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
<div id="bookstagramContent"></div>
<div id="fbtContent"></div>
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
<script src="/js/delivery-estimate.js" defer></script>
<script src="/js/cart.js"></script>
<script src="/js/google-discount.js"></script>
<script src="/js/google-customer-reviews.js"></script>
<script src="/js/checkout.js"></script>
<script src="/js/auth.js"></script>
<script>
const BOOKS = BOOKS_DATA_PLACEHOLDER;
const SOCIAL_PROOF = SOCIAL_PROOF_PLACEHOLDER;

// ── Lookup book by slug ───────────────────────────────────────────────────
const BOOK_MAP = {};
BOOKS.forEach(b => { BOOK_MAP[b.slug] = b; });

function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Ship-by date + delivery estimate ─────────────────────────────────────────
// Cutoff is 03:00 IST — the nightly courier manifest closes then. An order
// placed BEFORE 03:00 still makes that morning's dispatch (ships same day);
// from 03:00 onwards it waits for the next one (ships next day).
// Exception: Off Campus 5-book collection → always one extra day (limited stock).
const SLOW_SHIP_SLUGS = new Set(['off-campus-complete-5-book-collection-elle-kennedy']);
const SHIP_CUTOFF_HOUR_IST = 3;

// Transit days from the Delhi warehouse, by distance band.
const DELIVERY_ZONES = [
  { label: 'Delhi NCR',      days: 1 },
  { label: 'Nearby states',  days: 2 },
  { label: 'Rest of India',  days: 3 },
];

function istNow() {
  // Shift into IST so the UTC getters read as IST wall-clock values.
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}

function fmtDay(date) {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC'
  }).format(date);
}

function fmtDayShort(date) {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'
  }).format(date);
}

function addDays(date, n) {
  return new Date(date.getTime() + n * 24 * 60 * 60 * 1000);
}

function handlingDaysFor(book, slug) {
  // Admin-set handling time wins. SLOW_SHIP_SLUGS is the old hardcoded list and
  // stays as the fallback so titles on it keep their extra day until someone
  // sets a value in the panel.
  const set = Number(book && book.handling_days);
  if (Number.isFinite(set) && set > 0) return Math.min(30, Math.round(set));
  return SLOW_SHIP_SLUGS.has(slug) ? 1 : 0;
}

function getShipByHTML(book) {
  const slug = (book && book.slug) || '';
  const nowIST = istNow();
  const istHour = nowIST.getUTCHours(); // 0–23, IST wall clock

  const handling = handlingDaysFor(book, slug);
  const isLimited = handling > 0;
  // Before 03:00 IST the order still catches today's manifest.
  let daysToShip = (istHour < SHIP_CUTOFF_HOUR_IST ? 0 : 1) + handling;

  const shipDate = addDays(nowIST, daysToShip);
  const shipStr = fmtDay(shipDate);

  const subText = isLimited
    ? `Allow ${handling} extra ${handling === 1 ? 'day' : 'days'} before dispatch`
    : (daysToShip === 0
        ? 'Order now and it is dispatched today'
        : 'Order now to get it dispatched tomorrow');

  const zoneRows = DELIVERY_ZONES.map(z =>
    `<div class="eta-row"><span class="eta-zone">${z.label}</span>` +
    `<span class="eta-date">${fmtDayShort(addDays(shipDate, z.days))}</span></div>`
  ).join('');

  return `
    <div class="ship-by-box">
      <div class="ship-by-icon">📦</div>
      <div class="ship-by-text">
        <div class="ship-by-label">Ships by</div>
        <div class="ship-by-date">${shipStr}</div>
        <div class="ship-by-sub">${subText}</div>
        ${isLimited ? '<div class="ship-by-limited">⚡ Limited stock</div>' : ''}
        <div class="eta-block" data-delivery-eta${isLimited ? ` data-extra-days="${handling}"` : ''}>
          <div class="eta-head">Estimated delivery</div>
          ${zoneRows}
        </div>
      </div>
    </div>`;
}

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
  if (override.scarcity != null) next.sc = override.scarcity ? 1 : 0;
  // Manual stock: null/absent = in stock; <=0 = sold out ("Coming Soon").
  if (override.stock_qty !== null && override.stock_qty !== undefined) next.stock = override.stock_qty;
  if (override.image_url) next.img = override.image_url;  // cover image override
  // The "Genuine — Publisher Sourced" badge is an admin toggle for every
  // product, not just tag-carrying imports, so a non-null override wins over
  // whatever the tag said. Null = no admin opinion; keep the tag's answer.
  if (override.publisher_sourced != null) next.publisher_sourced = !!override.publisher_sourced;
  // Per-product handling time: extra days before dispatch. Absent = store default.
  if (override.handling_days != null) next.handling_days = override.handling_days;
  return next;
}
function isSoldOut(book) {
  return book && book.stock !== null && book.stock !== undefined && Number(book.stock) <= 0;
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
    // True when the custom_products row carries the tag emitted by the
    // Crossword-bestseller importer — surfaces the "Genuine, sourced from the
    // publisher" banner on the product page. Cheap string contains so any
    // future tag-driven banners can follow the same pattern.
    publisher_sourced: /publisher-sourced-bestseller/i.test(String(product.tags || '')),
  };
}

// Cache product-overrides for 5 min in sessionStorage so navigating between
// product pages doesn't re-hit the Lambda each time (the response is ~100 KB
// and the function does a Supabase round-trip on cold start — was responsible
// for 5-10s blank product pages).
const OVERRIDES_CACHE_KEY = 'iac_overrides_cache_v1';
const OVERRIDES_CACHE_TTL_MS = 5 * 60 * 1000;

function getCachedOverrides() {
  try {
    const raw = sessionStorage.getItem(OVERRIDES_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || (Date.now() - (parsed.ts || 0) > OVERRIDES_CACHE_TTL_MS)) return null;
    return parsed.data;
  } catch { return null; }
}
function setCachedOverrides(data) {
  try { sessionStorage.setItem(OVERRIDES_CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch {}
}

function pickOverrideFor(data, slug) {
  const key = String(slug || '').toLowerCase();
  const override = (data?.overrides || []).find(o => String(o.slug || '').toLowerCase() === key) || null;
  const customProduct = (data?.custom_products || []).find(o => String(o.slug || '').toLowerCase() === key) || null;
  return { override, customProduct };
}

let _overridesInflight = null;
async function fetchOverridesFresh() {
  if (_overridesInflight) return _overridesInflight;
  _overridesInflight = (async () => {
    try {
      // Default cache so the browser + any CDN in front can short-circuit
      // repeat hits. The endpoint sets its own Cache-Control too.
      const res = await fetch('/.netlify/functions/get-product-overrides');
      if (!res.ok) return null;
      const data = await res.json();
      setCachedOverrides(data);
      return data;
    } catch (err) {
      console.warn('Product override unavailable:', err.message);
      return null;
    } finally {
      _overridesInflight = null;
    }
  })();
  return _overridesInflight;
}

// Non-blocking variant returns whatever is cached now (possibly null).
// Render path calls this first, then schedules a background refresh that
// patches the page if a newer override lands.
function loadOverridesNow(slug) {
  const cached = getCachedOverrides();
  return cached ? pickOverrideFor(cached, slug) : { override: null, customProduct: null };
}
async function loadOverridesFresh(slug) {
  const data = await fetchOverridesFresh();
  return data ? pickOverrideFor(data, slug) : { override: null, customProduct: null };
}

// Back-compat: the old name used to await the network. Now it only awaits
// the network if nothing is cached — first paint never blocks on it.
async function loadSingleProductOverride(slug) {
  const cached = getCachedOverrides();
  if (cached) {
    // Fire-and-forget revalidation so the next page view is fresh too.
    fetchOverridesFresh().catch(() => {});
    return pickOverrideFor(cached, slug);
  }
  return loadOverridesFresh(slug);
}

// ── Track recently viewed products (for future "Based on what you viewed") ──
function trackProductView(b) {
  try {
    const key = 'iac_viewed';
    const entry = { slug: b.slug, t: b.t, a: b.a, img: b.img, p: b.p, cat: b.cat, ts: Date.now() };
    const prev = JSON.parse(localStorage.getItem(key) || '[]');
    const updated = [entry, ...prev.filter(e => e.slug !== b.slug)].slice(0, 30);
    localStorage.setItem(key, JSON.stringify(updated));
  } catch(e) {}
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
          <span class="prod-price" data-product-price="${sale}">${esc(b.p)}</span>
          ${b.op ? `<span class="prod-orig" data-product-original-price="${b.op}">${esc(b.op)}</span>` : ''}
          ${savePct ? `<span class="prod-saving">Save ${savePct}%</span>` : ''}
        </div>

        <div id="razorpay-affordability-widget"></div>

        ${Date.now() < new Date('2026-08-15T18:29:59Z').getTime() ? `
        <div class="prod-sale-box">
          <div class="prod-sale-box-head">🇮🇳 Freedom Sale · 15 August</div>
          ${sale > 399 ? `<span class="prod-sale-price">₹${Math.max(1, sale - Math.floor(sale * 0.15)).toLocaleString('en-IN')}</span><span class="prod-sale-saving">You save ₹${Math.floor(sale * 0.15).toLocaleString('en-IN')} (15%)</span>` : ''}
          <div class="prod-sale-code"><strong>FREEDOM</strong> auto-applies when your order subtotal is above ₹399.</div>
          <div class="prod-sale-timer" style="margin-top:0.5rem;">
            <span class="prod-cd-label">Ends in</span>
            <div class="prod-cd" id="prodCountdown"></div>
          </div>
        </div>` : ''}

        ${b.sc ? `<div class="prod-scarcity">
          <span class="scarcity-dot"></span>
          <span>🔥 Hurry! Only <strong>4 left</strong> in stock</span>
        </div>` : ''}

        ${getShipByHTML(b)}

        <div class="prod-courier-row">
          <span class="prod-courier-label">Shipped via</span>
          <span class="prod-courier-logos">
            <span class="prod-courier-tag">Delhivery</span>
            <span class="prod-courier-tag">Amazon Shipping</span>
            <span class="prod-courier-tag">Xpressbees</span>
          </span>
        </div>

        <div class="prod-refund-guarantee">
          🛡️ <strong>100% Delivery Guarantee</strong> — If your order is not delivered for any reason, a full refund will be issued within 24 hours. No questions asked.
        </div>

        <div class="prod-trust-row" aria-label="Purchase benefits">
          <span>🚚 2–5 day delivery</span>
          <span>💵 COD available</span>
          <span>💳 UPI/cards</span>
          <span>🛡 7-day replacement</span>
        </div>

        <div class="pdp-cred" aria-label="Store credibility"><span class="cred-chip">📦 25,000+ orders fulfilled</span></div> <a href="https://www.instagram.com/inkandchai.in/" target="_blank" rel="noopener" class="meta-verified" title="Ink &amp; Chai on Instagram — Meta Verified Business"><img src="/images/meta-verified-inkandchai.webp" alt="Ink &amp; Chai is a Meta Verified Business on Instagram — 28.8K followers" width="760" height="368" loading="lazy"/><span class="meta-verified-cap"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="#fff" d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.68.88-3.34 2.19c-1.39-.46-2.9-.2-3.91.81s-1.26 2.52-.81 3.91c-1.31.67-2.19 1.91-2.19 3.34s.88 2.67 2.19 3.34c-.45 1.39-.2 2.9.81 3.91s2.52 1.26 3.91.81c.66 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34z"/><path fill="#1877F2" d="M10.09 15.42l-3.8-3.79 1.41-1.42 2.39 2.38 5.62-5.62 1.41 1.42z"/></svg>Meta Verified Business →</span></a>

        <a href="https://www.instagram.com/inkandchai.in/" target="_blank" rel="noopener" class="insta-trust-btn">
          <span class="insta-trust-btn-icon">📸</span>
          <span class="insta-trust-btn-body">
            <span class="insta-trust-btn-title">Still Doubtful? Check our Bookstagram</span>
            <span class="insta-trust-btn-sub">@inkandchai.in · Real unboxings from real customers</span>
          </span>
          <span class="insta-trust-btn-arrow">→</span>
        </a>

        ${b.desc ? `
          <div>
            <div class="prod-desc-title">About this book</div>
            <p class="prod-desc" id="descText">${esc(b.desc)}</p>
          </div>` : ''}

        ${(b.description_banners && b.description_banners.length) ? `
          <div style="margin-top:1.8rem;">
            ${b.description_banners.map((src,i) => `
              <img src="${esc(src)}" alt="${esc(b.t)} — product detail ${i+1}"
                   loading="lazy" style="width:100%;display:block;margin-bottom:0.5rem;border-radius:4px;"
                   onclick="openLightbox(this.src, this.alt)" />`).join('')}
          </div>` : ''}

        <div class="prod-meta-grid">
          ${b.cat  ? `<div class="prod-meta-item"><div class="prod-meta-label">Category</div><div class="prod-meta-val">${esc(b.cat)}</div></div>` : ''}
          ${b.a    ? `<div class="prod-meta-item"><div class="prod-meta-label">Author</div><div class="prod-meta-val">${esc(b.a)}</div></div>` : ''}
          ${b.pub  ? `<div class="prod-meta-item"><div class="prod-meta-label">Publisher</div><div class="prod-meta-val">${esc(b.pub)}</div></div>` : ''}
          ${b.isbn ? `<div class="prod-meta-item"><div class="prod-meta-label">ISBN</div><div class="prod-meta-val">${esc(b.isbn)}</div></div>` : ''}
          <div class="prod-meta-item"><div class="prod-meta-label">Delivery</div><div class="prod-meta-val">Pan-India · 2–5 days</div></div>
          <div class="prod-meta-item"><div class="prod-meta-label">Returns</div><div class="prod-meta-val">7-day easy returns · <a href="#" onclick="event.preventDefault();openReturnVideo();" style="color:var(--gold);text-decoration:underline;cursor:pointer;">▶ Watch how (30 sec)</a></div></div>
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
          ${isSoldOut(b) ? `
          <div class="coming-soon-box" style="display:flex;flex-direction:column;gap:0.3rem;padding:1rem 1.2rem;border:1px solid rgba(232,160,48,0.4);background:rgba(232,160,48,0.08);border-radius:2px;text-align:center;">
            <div style="font-size:0.62rem;letter-spacing:0.28em;text-transform:uppercase;color:#e8a030;font-weight:700;">Coming Soon</div>
            <div style="font-size:0.78rem;color:var(--cream-dim);">Currently out of stock — check back soon.</div>
          </div>` : `
          <button class="btn-cart" data-slug="${esc(b.slug)}" onclick="addBookToCart(this.dataset.slug, this)">
            + Add to Cart
          </button>
          <button class="btn-cod" data-slug="${esc(b.slug)}" onclick="buyNowBook(this.dataset.slug, this)">
            ⚡ Buy Now — ${esc(b.p)}
          </button>`}
          <div style="display:flex;gap:0.6rem;margin-top:0.2rem">
            <button class="btn-share" onclick="shareBook()">↗ Share</button>
            <button id="prodWishBtn"
              onclick="if(window.toggleWishlist){ toggleWishlist({url:'${esc(b.url)}',title:'${esc(b.t).replace(/'/g,'\\u0027')}',img:'${esc(b.img)}',price:${sale}}); updateProdWishBtn(); }"
              class="btn-share" title="Save to wishlist">♡ Wishlist</button>
          </div>
        </div>

        ${b.publisher_sourced ? `
        <div class="publisher-sourced-box" style="border:1px solid rgba(110,170,110,0.35);background:linear-gradient(135deg,rgba(110,170,110,0.10),rgba(201,168,76,0.05));padding:1rem 1.2rem;border-radius:2px;margin-bottom:0.9rem;display:flex;gap:0.85rem;align-items:flex-start;">
          <div style="font-size:1.4rem;line-height:1;">📚</div>
          <div>
            <div style="font-size:0.56rem;letter-spacing:0.28em;text-transform:uppercase;color:#6daa6d;margin-bottom:0.35rem;font-weight:600;">Genuine — Publisher Sourced</div>
            <div style="font-size:0.76rem;color:var(--cream);line-height:1.65;">This title is sourced <strong>directly from the publisher</strong> — no third-party resellers, no piracy. Original copy, MRP printed on the back${(() => {
              // The discount used to be hardcoded at 22.5%, which was true of the
              // bulk import and false the moment the badge was applied anywhere
              // else. State the discount this listing actually offers, or say
              // nothing about price at all.
              const num = v => Number(String(v || '').replace(/[^0-9.]/g, '')) || 0;
              const price = num(b.p), mrp = num(b.op);
              if (!(price > 0 && mrp > price)) return '';
              const off = Math.round((1 - price / mrp) * 1000) / 10;
              return off >= 1 ? `, at ${off % 1 === 0 ? off.toFixed(0) : off.toFixed(1)}% off` : '';
            })()}.</div>
            <div style="font-size:0.72rem;color:var(--cream-dim);line-height:1.65;margin-top:0.45rem;"><strong style="color:var(--gold);">🧾 GST invoice available</strong> on request — reply to your order confirmation email with your GSTIN.</div>
          </div>
        </div>` : ''}

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
          ${(b.review_image || b.review_images?.length || b.review_video) ? `
          <div class="review-media">
            ${(b.review_images && b.review_images.length > 1)
              ? b.review_images.map((img,i) => `<figure><img src="${esc(img)}" alt="${esc(b.t)} customer review photo ${i+1}" loading="lazy" onclick="openLightbox(this.src, this.alt)" style="cursor:zoom-in"/><figcaption>Customer photo</figcaption></figure>`).join('')
              : b.review_image ? `<figure><img src="${esc(b.review_image)}" alt="${esc(b.t)} customer review photo" loading="lazy" onclick="openLightbox(this.src, this.alt)" /><figcaption>Customer photo shared after delivery</figcaption></figure>` : ''}
            ${b.review_video ? `<figure><video src="${esc(b.review_video)}" controls playsinline preload="metadata"></video><figcaption>Customer video review / unboxing</figcaption></figure>` : ''}
          </div>` : ''}
          <p class="review-note">Readers choose Ink &amp; Chai for fast delivery, careful packing and checkout-backed order updates.</p>
        </section>` : ''}

        <!-- Live customer reviews loaded from Supabase -->
        <section class="live-reviews-section" id="liveReviewsSection" style="display:none">
          <div class="live-reviews-head">
            <div class="live-reviews-title">Customer Reviews</div>
            <span class="live-reviews-badge" id="liveReviewsBadge"></span>
          </div>
          <div id="liveReviewsList"></div>
        </section>
      </div>
    </div>

    <!-- Mobile sticky bottom bar (shown only on mobile via CSS) -->
    <div class="prod-bottom-bar">
      ${isSoldOut(b) ? `
      <div style="flex:1;text-align:center;padding:0.7rem;font-size:0.66rem;letter-spacing:0.2em;text-transform:uppercase;color:#e8a030;font-weight:700;">Coming Soon — out of stock</div>` : `
      <button class="pbb-cart" data-slug="${esc(b.slug)}" onclick="addBookToCart(this.dataset.slug, this)">
        + Add to Cart
      </button>
      <button class="pbb-buy" data-slug="${esc(b.slug)}" onclick="buyNowBook(this.dataset.slug, this)">
        Buy Now · ${esc(b.p)}
      </button>`}
    </div>
  `;
  // The pincode delivery estimate lives in markup that was just replaced.
  if (window.iacDeliveryEtaInit) window.iacDeliveryEtaInit();
  // Set initial wishlist state
  setTimeout(updateProdWishBtn, 100);
  // Load live reviews
  if (b && b.slug) loadLiveReviews(b.slug);
  // Razorpay Affordability Widget
  (function() {
    try {
      const priceEl = document.querySelector('[data-product-price]');
      const amountPaise = priceEl ? Math.round(parseFloat(priceEl.dataset.productPrice) * 100) : 0;
      if (!amountPaise || !window.RAZORPAY_KEY_ID || !window.RazorpayAffordabilitySuite) return;
      // Clear any previous render
      const widgetEl = document.getElementById('razorpay-affordability-widget');
      if (widgetEl) widgetEl.innerHTML = '';
      new window.RazorpayAffordabilitySuite({ key: window.RAZORPAY_KEY_ID, amount: amountPaise }).render();
    } catch(e) { /* silent — widget optional */ }
  })();

  // Product page sale countdown
  const _saleEnd = new Date('2026-08-15T18:29:59Z');
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

// ── Load live customer reviews for current product ──────────────────────────
async function loadLiveReviews(slug) {
  if (!slug) return;
  try {
    const res = await fetch('/.netlify/functions/get-reviews?slug=' + encodeURIComponent(slug));
    if (!res.ok) return;
    const { reviews } = await res.json();
    if (!reviews || reviews.length === 0) return;
    const section = document.getElementById('liveReviewsSection');
    const list    = document.getElementById('liveReviewsList');
    const badge   = document.getElementById('liveReviewsBadge');
    if (!section || !list) return;
    const avg = (reviews.reduce((s,r) => s + r.rating, 0) / reviews.length).toFixed(1);
    badge.textContent = avg + ' ★  ·  ' + reviews.length + ' verified review' + (reviews.length > 1 ? 's' : '');
    list.innerHTML = reviews.map(r => {
      const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
      const date  = new Date(r.created_at).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
      return \`<div class="live-review-card">
        <div class="live-review-top">
          <span class="live-review-stars">\${stars}</span>
          <span class="live-review-date">\${date}</span>
        </div>
        <div class="live-review-name">\${r.customer_name || 'Verified Buyer'}</div>
        \${r.comment ? \`<div class="live-review-body">\${r.comment.replace(/</g,'&lt;')}</div>\` : ''}
        \${r.verified_buyer ? '<div class="live-review-verified">✓ Verified Purchase</div>' : ''}
      </div>\`;
    }).join('');
    section.style.display = 'block';
  } catch(e) { /* silent fail */ }
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
// Rendered by the shared /js/reels.js module: a light poster strip that opens
// an Instagram-style vertical viewer. Loads video only when a reel is opened,
// and only the active one — and reels stream from Supabase's CDN, so this adds
// zero Netlify video bandwidth.
function renderBookstagram() {
  const el = document.getElementById('bookstagramContent');
  if (!el) return;
  window.__IAC_REELS__ = (window.SOCIAL_PROOF || []);
  if (window.IACReels) { window.IACReels.mount(el); return; }
  if (document.getElementById('iac-reels-js')) return;   // already loading
  const s = document.createElement('script');
  s.id = 'iac-reels-js'; s.src = '/js/reels.js'; s.defer = true;
  document.head.appendChild(s);
}

// Expose social-proof JSON to renderer
window.SOCIAL_PROOF = SOCIAL_PROOF;

// ── Related books — multi-signal scoring ────────────────────────────────
// Signals: author, series/title keywords, tags, category, description
// genre-words, price proximity, trending, new arrival.
(function() {
  const STOP = new Set(['the','a','an','of','and','by','in','to','for','with',
    'book','books','edition','special','hindi','volume','vol','series','set',
    'complete','collection','combo','part','chapter','tale','story']);
  const GENRE_SIGNALS = ['romance','thriller','mystery','fantasy','horror',
    'mythology','psychology','money','finance','hockey','college','magic',
    'war','history','discipline','self-help','motivation','manga','comic',
    'biography','spiritual','yoga','crime','detective','vampire','werewolf',
    'enemies','lovers','spicy','dark','academia','mafia','billionaire',
    'arranged','marriage','forced','proximity','second','chance'];

  function titleWords(t) {
    return (t||'').toLowerCase().split(/\s+/)
      .filter(w => w.length > 3 && !STOP.has(w));
  }
  function tagSet(b) {
    return new Set((b.tags||'').toLowerCase().split(/[\s,]+/).filter(w=>w.length>2));
  }
  function descSignals(d) {
    const lower = (d||'').toLowerCase();
    return GENRE_SIGNALS.filter(g => lower.includes(g));
  }

  function scoreBook(b, x) {
    let s = 0;
    const bA = (b.a||'').toLowerCase().trim();
    const xA = (x.a||'').toLowerCase().trim();

    // ① Exact author match — strongest (catches all books by same author)
    if (bA && xA === bA) s += 12;
    else if (bA && xA) {
      const bW = bA.split(/\s+/), xW = new Set(xA.split(/\s+/));
      if (bW.some(w => w.length > 2 && xW.has(w))) s += 4;
    }

    // ② Series / title keyword overlap (e.g. "Off Campus", "Kings of Sin")
    const bTW = titleWords(b.t), xTWSet = new Set(titleWords(x.t));
    const titleOverlap = bTW.filter(w => xTWSet.has(w)).length;
    s += titleOverlap * 6;   // 1 shared word = +6, "Off Campus" = +12

    // ③ Shared tags
    const bTags = tagSet(b), xTags = tagSet(x);
    let tagHits = 0;
    bTags.forEach(t => { if (xTags.has(t)) tagHits++; });
    s += Math.min(tagHits * 2, 10);   // cap at +10

    // ④ Same category
    if (x.cat && x.cat === b.cat) s += 6;

    // ⑤ Description genre-word overlap
    const bSig = new Set(descSignals(b.desc));
    const xSig = descSignals(x.desc);
    const descHits = xSig.filter(g => bSig.has(g)).length;
    s += Math.min(descHits * 1.5, 6);

    // ⑥ Same broad tab
    if (x.tab && x.tab === b.tab) s += 2;

    // ⑥b Language match (Hindi vs English) — cross-language is penalised so
    //     English titles don't surface on Hindi editions/combos and vice-versa.
    const isHi = o => {
      const hay = (o.t||'') + ' ' + (o.cat||'') + ' ' + (o.a||'');
      return /[\\u0900-\\u097F]/.test(hay) || /hindi/i.test(hay);
    };
    s += (isHi(b) === isHi(x)) ? 5 : -9;

    // ⑦ Price proximity (same budget = same shopper)
    const bp = parseFloat(b.p)||0, xp = parseFloat(x.p)||0;
    if (bp && xp) {
      const diff = Math.abs(bp-xp)/Math.max(bp,xp);
      if (diff < 0.15) s += 3;
      else if (diff < 0.35) s += 1.5;
    }

    // ⑧ Quality / freshness signals
    if (x.img) s += 0.5;
    if (x.n)   s += 1;   // new arrival
    if (parseFloat(x.rating||0) >= 4.5) s += 1;

    return s;
  }

  window._scoreBook = scoreBook;   // expose for search-aware boost below
})();

function renderRelated(b) {
  const candidates = BOOKS.filter(x => x.url !== b.url && x.slug !== b.slug);

  // Score every candidate
  const withScore = candidates
    .map(x => ({ x, s: window._scoreBook(b, x) }))
    .filter(({ s }) => s > 0)
    .sort((a, z) => z.s - a.s);

  // ── Section A: same author / same series (top 5) ──
  const authorNorm = (b.a||'').toLowerCase().trim();
  const sameAuthor = withScore
    .filter(({ x }) => (x.a||'').toLowerCase().trim() === authorNorm)
    .slice(0, 5).map(({ x }) => x);

  // ── Section B: "You May Also Like" — genre/tag/category matches
  //    Exclude anything already in sameAuthor
  const saSet = new Set(sameAuthor.map(r => r.slug));
  let alsoLike = withScore
    .filter(({ x }) => !saSet.has(x.slug))
    .slice(0, 10).map(({ x }) => x);

  // Fallback when scores are too low
  if (alsoLike.length < 4) {
    alsoLike = BOOKS
      .filter(x => x.cat === b.cat && x.url !== b.url && !saSet.has(x.slug))
      .slice(0, 8);
  }

  // ── Search-aware boost: recently searched terms ───────────────────────
  // Reads from localStorage key 'iac_searches' (written by search overlay)
  try {
    const searches = JSON.parse(localStorage.getItem('iac_searches') || '[]');
    if (searches.length) {
      const needle = searches.slice(-5).join(' ').toLowerCase();
      alsoLike.sort((a, z) => {
        const aHit = (a.t+' '+(a.tags||'')).toLowerCase().includes(needle) ? 1 : 0;
        const zHit = (z.t+' '+(z.tags||'')).toLowerCase().includes(needle) ? 1 : 0;
        return zHit - aHit;
      });
    }
  } catch(e) {}

  const container = document.getElementById('relatedContent');
  if (!container) return;

  const makeCard = r => `
    <a class="rel-card" href="/product/${r.slug}/" style="text-decoration:none;display:block">
      <div class="rel-cover">
        ${r.img ? `<img src="${esc(r.img)}" alt="${esc(r.t)}" loading="lazy"/>` : ''}
        ${r.n ? '<span style="position:absolute;top:6px;left:6px;background:var(--gold);color:var(--bg);font-size:0.42rem;letter-spacing:0.2em;padding:2px 6px;font-family:\\'Inter\\',sans-serif;font-weight:700;text-transform:uppercase;">NEW</span>' : ''}
      </div>
      <div class="rel-title">${esc(r.t)}</div>
      <div class="rel-author">${esc(r.a||'')}</div>
      <div class="rel-price">₹${esc(r.p)}${r.op && r.op!==r.p ? ` <span style="text-decoration:line-through;color:var(--muted);font-size:0.75em">₹${esc(r.op)}</span>` : ''}</div>
    </a>`;

  let html = '';

  if (sameAuthor.length) {
    html += `<div class="related">
      <h2 class="related-title">More by <em>${esc(b.a)}</em></h2>
      <div class="related-grid">${sameAuthor.map(makeCard).join('')}</div>
    </div>`;
  }

  if (alsoLike.length) {
    html += `<div class="related" style="margin-top:${sameAuthor.length?'2.5rem':'0'}">
      <h2 class="related-title">You May Also <em>Like</em></h2>
      <div class="related-grid">${alsoLike.map(makeCard).join('')}</div>
    </div>`;
  }

  if (html) container.innerHTML = html;
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
  // Fall back to a stub built from the button's data-* / page state if BOOK_MAP
  // hasn't loaded yet (cold first paint with slow preload). Better than
  // silently doing nothing and making the user click again.
  let b = BOOK_MAP[bookSlug];
  if (!b && typeof currentItem !== 'undefined' && currentItem && (currentItem.slug === bookSlug || currentItem.url?.includes(bookSlug))) {
    b = currentItem;
  }
  if (!b) { if (window.showToast) showToast('Still loading book data — please try again in a second.'); return; }

  const qty = getQty();
  const item = cartItemForBook(b, bookSlug, qty);
  localStorage.removeItem('iac_buy_now_cart');
  const CART_KEY = 'akshar_cart';
  const cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
  const existing = cart.find(i => i.id === item.id);
  if (existing) { existing.qty += qty; } else { cart.push({ ...item, qty }); }
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  // Open cart synchronously — no artificial setTimeout. Was 220ms of fake
  // loading state on every add.
  if (window.openCart)  openCart();
  if (window.showToast) showToast(`${qty > 1 ? qty + '× ' : ''}"${item.title.slice(0,28)}…" added to cart`);
}

function buyNowBook(bookSlug, trigger) {
  let b = BOOK_MAP[bookSlug];
  if (!b && typeof currentItem !== 'undefined' && currentItem && (currentItem.slug === bookSlug || currentItem.url?.includes(bookSlug))) {
    b = currentItem;
  }
  if (!b) { if (window.showToast) showToast('Still loading — please try again in a second.'); return; }
  buttonLoading(trigger, true);
  localStorage.setItem('iac_buy_now_cart', JSON.stringify([cartItemForBook(b, bookSlug, getQty())]));
  // Navigate immediately — the prior 260ms delay was just for a UI spinner
  // the customer barely sees before the next page replaces it.
  window.location.href = '/checkout/?buynow=1';
}

// ── Init ──────────────────────────────────────────────────────────────────
const params  = new URLSearchParams(window.location.search);
const pathParts = window.location.pathname.split('/').filter(Boolean);
const pathSlug = pathParts[0] === 'product' && pathParts[1] ? pathParts[1] : '';
const slug    = params.get('id') || pathSlug;

(async () => {
  const foundBook = slug ? BOOK_MAP[slug] : null;
  // Stale-while-revalidate: render whatever we have NOW (static catalogue +
  // cached overrides if any), then patch the page when fresh overrides arrive.
  // Previously every product page awaited the network before rendering, which
  // was 5-10s on cold Lambda.
  const cachedLive = slug ? loadOverridesNow(slug) : { override: null, customProduct: null };

  function renderEverything(liveData) {
    const baseBook = foundBook || customProductToBook(liveData.customProduct);
    if (!baseBook) {
      document.getElementById('productContent').innerHTML = `
        <div class="not-found">
          <h2>Book not found</h2>
          <p>This page may have moved. <a href="/" style="color:var(--gold)">Browse all books →</a></p>
        </div>`;
      return false;
    }
    const liveBook = applyProductOverride(baseBook, liveData.override);
    renderProduct(liveBook);
    trackProductView(liveBook);
    // ViewContent. content_ids uses the same field the cart stores as `id`
    // (b.url), so a view, an add and a purchase all name the product
    // identically — otherwise Meta cannot connect them or match the catalogue.
    if (window.iacMeta) {
      window.iacMeta('ViewContent', {
        content_ids: [String(liveBook.url || liveBook.slug || '')],
        content_type: 'product',
        content_name: String(liveBook.t || ''),
        content_category: String(liveBook.cat || ''),
        currency: 'INR',
        value: Number(String(liveBook.p || '').replace(/[^0-9.]/g, '')) || 0,
      });
    }
    renderFBT(liveBook);
    renderBookstagram();
    renderRelated(liveBook);
    return true;
  }

  // If we have a static book OR a cached override, paint immediately.
  if (foundBook || cachedLive.customProduct) {
    renderEverything(cachedLive);
    // Background revalidation — repaint silently if the live data differs.
    fetchOverridesFresh().then(data => {
      if (!data) return;
      const fresh = pickOverrideFor(data, slug);
      const changed = JSON.stringify(fresh) !== JSON.stringify(cachedLive);
      if (changed) renderEverything(fresh);
    }).catch(() => {});
  } else {
    // No static match, no cache — we must wait on the network to know whether
    // it's a custom_products row or genuinely missing.
    const fresh = slug ? await loadOverridesFresh(slug) : { override: null, customProduct: null };
    renderEverything(fresh);
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

# Start fetching the books preload early (see note in HTML setup above).
PRODUCT_HTML = PRODUCT_HTML.replace("</title>", f"</title>\n{BOOKS_FULL_PRELOAD}", 1)
PRODUCT_HTML = PRODUCT_HTML.replace("BOOKS_DATA_PLACEHOLDER",        "window.BOOKS_PRELOAD||[]")
PRODUCT_HTML = PRODUCT_HTML.replace('<script src="/js/auth.js"></script>\n<script>\nconst BOOKS = window.BOOKS_PRELOAD||[];',
                                    f'<script src="/js/auth.js"></script>\n{BOOKS_FULL_TAG}\n<script>\nconst BOOKS = window.BOOKS_PRELOAD||[];')
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

def _price_to_number(raw):
    """A display price ('₹ 1,299') as a bare float. 0.0 when absent or unparseable."""
    try:
        return float(re.sub(r"[^0-9.]", "", str(raw or "")) or 0)
    except Exception:
        return 0.0

def absolute_img(book, large=False):
    """Absolute cover URL. `large=True` returns the hero-sized variant used by
    the product page's big cover slot (falls back to the card size if absent)."""
    img = (book.get("img_lg") if large else None) or book.get("img") or ""
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

def product_faq_json_ld(book):
    """FAQPage schema — Google shows expandable FAQs in search results (huge CTR boost).

    The same 5 questions appear on every product page but Google still rewards the
    rich snippet. Questions are calibrated to match high-volume search intent like
    'is X genuine', 'cash on delivery', 'return policy', 'delivery time'."""
    price  = int(price_number(book))
    title  = book.get("t", "this book")
    author = book.get("a", "")
    ld = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {
                "@type": "Question",
                "name": f"Is {title} a genuine original book?",
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": f"Yes — {title}{(' by ' + author) if author else ''} sold on inkandchai.in is a 100% genuine paperback sourced directly from the publisher or authorised distributors. Every copy is brand new, not pirated or photocopied."
                }
            },
            {
                "@type": "Question",
                "name": f"How long does delivery take for {title}?",
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": "Standard pan-India delivery takes 2–5 business days. Orders are dispatched within 24 hours from our Delhi warehouse. Free shipping applies on orders above ₹499."
                }
            },
            {
                "@type": "Question",
                "name": "Is cash on delivery available?",
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": f"Yes, COD is available across India for this book. You can also pay online via UPI, debit/credit cards, or net banking — prepaid orders include a guaranteed cashback scratch card worth up to ₹200 off your next purchase."
                }
            },
            {
                "@type": "Question",
                "name": "What is the return policy?",
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": "We offer a 7-day return window from the date of delivery. If the book arrives damaged, is the wrong title, or doesn't match the description, request a return from your My Orders page on inkandchai.in. Refunds are processed automatically once we receive the book back."
                }
            },
            {
                "@type": "Question",
                "name": f"What's the price of {title}?",
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": f"{title} is available on inkandchai.in for ₹{price}. Prices include all taxes. Free shipping on orders above ₹499."
                }
            },
        ],
    }
    return json.dumps(ld, ensure_ascii=False).replace("</", "<\\/")


def breadcrumb_json_ld(book):
    """BreadcrumbList schema — Google replaces the URL in search results with the
    breadcrumb trail (Home › Category › Book), which boosts CTR ~10-15%."""
    cat   = book.get("cat") or "Books"
    title = book.get("t", "")
    items = [
        {"@type": "ListItem", "position": 1, "name": "Home",     "item": SITE},
        {"@type": "ListItem", "position": 2, "name": cat,        "item": f"{SITE}/category/?name={quote(cat)}"},
        {"@type": "ListItem", "position": 3, "name": title,      "item": product_abs_url(book["slug"])},
    ]
    ld = {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": items}
    return json.dumps(ld, ensure_ascii=False).replace("</", "<\\/")


# ── Multi-signal "You May Also Like" relevance (static pages) ────────────────
# Mirrors the richer JS scorer used on dynamic pages, and adds a LANGUAGE signal
# (Hindi vs English) so English titles stop showing up on Hindi combo pages and
# vice-versa — the main cause of "not so related" picks. Signals, strongest
# first: same author / series-title-keyword overlap / same language / same
# category / shared genre words / price proximity, with a hard cross-language
# penalty and a relevance floor so a shared broad category alone isn't enough.
_REL_STOP = {
    "the","a","an","of","and","by","in","to","for","with","book","books","edition",
    "special","hindi","english","volume","vol","series","set","complete","collection",
    "combo","part","novel","paperback","new","best","selling","bestseller","author",
    "story","stories","tale","pack","box","boxset","from","your","you","how",
}
_REL_GENRE = [
    "romance","thriller","mystery","fantasy","horror","history","historical","science",
    "self","help","habit","money","finance","financial","wealth","invest","stock",
    "psychology","mindset","discipline","motivation","success","business","marketing",
    "leadership","productivity","spiritual","philosophy","biography","memoir","fiction",
    "poetry","manga","comic","children","enemies","lovers","mafia","billionaire","dark",
    "academia","war","crime","detective","adventure","classic","health","fitness",
    "entrepreneur","startup","habits","communication","negotiation","power","strategy",
]

def _rel_title_words(t):
    return {w for w in re.split(r"[^a-z0-9ऀ-ॿ]+", (t or "").lower())
            if len(w) > 3 and w not in _REL_STOP}

def _rel_is_hindi(b):
    hay = f"{b.get('t','')} {b.get('cat','')} {b.get('a','')}"
    if re.search(r"[ऀ-ॿ]", hay):     # Devanagari script present
        return True
    return "hindi" in hay.lower()

def _rel_genre_sig(b):
    hay = f"{b.get('t','')} {b.get('desc','')} {b.get('cat','')}".lower()
    return {g for g in _REL_GENRE if g in hay}

def _rel_is_combo(b):
    low = str(b.get("t","")).lower()
    return any(k in low for k in ("combo","set of","boxset","box set","collection",
                                  " pack","books |","2 books","3 books","4 books",
                                  "5 books","6 books"))

def _rel_price_num(v):
    m = re.search(r"\d[\d,]*", str(v or ""))
    return float(m.group(0).replace(",", "")) if m else 0.0

# Per-book feature cache — computed ONCE per book, then reused across every
# product page's scoring pass (otherwise scoring is O(N²) regex/desc scans).
_REL_FEAT = {}

def _rel_features(b):
    key = b.get("slug") or id(b)
    f = _REL_FEAT.get(key)
    if f is None:
        author = (b.get("a") or "").lower().strip()
        try:
            hi_rating = float(b.get("rating") or 0) >= 4.5
        except (TypeError, ValueError):
            hi_rating = False
        f = {
            "author":    author,
            "awords":    {w for w in author.split() if len(w) > 2},
            "tw":        _rel_title_words(b.get("t")),
            "sig":       _rel_genre_sig(b),
            "hindi":     _rel_is_hindi(b),
            "combo":     _rel_is_combo(b),
            "price":     _rel_price_num(b.get("p")),
            "cat":       b.get("cat", ""),
            "tab":       b.get("tab", ""),
            "img":       bool(b.get("img")),
            "new":       bool(b.get("n")),
            "hi_rating": hi_rating,
        }
        _REL_FEAT[key] = f
    return f

def related_books_for(book, count=10):
    """Return up to `count` genuinely-related books via multi-signal scoring."""
    current_url  = book.get("url", "")
    current_slug = book.get("slug", "")
    cur = _rel_features(book)

    def score(b):
        bf = _rel_features(b)
        s = 0.0
        # ① Author — exact match is the strongest signal (series / same author)
        if bf["author"] and bf["author"] == cur["author"]:
            s += 12
        elif cur["author"] and bf["author"] and (cur["awords"] & bf["awords"]):
            s += 4
        # ② Title / series keyword overlap ("Kings of Sin", "Psychology of Money")
        s += len(cur["tw"] & bf["tw"]) * 6
        # ③ Language match — strong; cross-language is heavily penalised
        s += 5 if bf["hindi"] == cur["hindi"] else -9
        # ④ Same category
        if bf["cat"] and bf["cat"] == cur["cat"]:
            s += 6
        # ⑤ Shared genre / topic words (title + description + category)
        s += min(len(cur["sig"] & bf["sig"]) * 1.5, 6)
        # ⑥ Same broad tab
        if bf["tab"] and bf["tab"] == cur["tab"]:
            s += 2
        # ⑦ Price proximity (same budget shopper)
        if cur["price"] and bf["price"]:
            diff = abs(cur["price"] - bf["price"]) / max(cur["price"], bf["price"])
            if diff < 0.15:   s += 3
            elif diff < 0.35: s += 1.5
        # ⑧ Format affinity (combos pair with combos, singles with singles)
        if bf["combo"] == cur["combo"]:
            s += 1.5
        # ⑨ Quality / freshness
        if bf["img"]:       s += 0.5
        if bf["new"]:       s += 1
        if bf["hi_rating"]: s += 1
        return s

    scored = sorted(
        ((score(b), b) for b in slim
         if b.get("url") != current_url and b.get("slug") != current_slug),
        key=lambda t: t[0], reverse=True,
    )
    # Relevance floor: needs more than a shared broad category alone. Same-category
    # + same-language clears it (6+5); a shared broad category cross-language does
    # not (6-9). One strong topical signal (author/title/genre) clears it too.
    filtered = [b for sc, b in scored if sc > 9]
    # Fallbacks keep the shelf full without reintroducing cross-language noise:
    if len(filtered) < count:
        seen = {b.get("slug") for b in filtered}
        filtered += [b for sc, b in scored
                     if b.get("slug") not in seen
                     and b.get("cat") == cur["cat"]
                     and _rel_features(b)["hindi"] == cur["hindi"]][: count - len(filtered)]
    if len(filtered) < 3:
        seen = {b.get("slug") for b in filtered}
        filtered += [b for sc, b in scored
                     if b.get("slug") not in seen
                     and _rel_features(b)["hindi"] == cur["hindi"]][: 3 - len(filtered)]
    return filtered[:count]


# ── Live customer reviews (static product pages) ───────────────────────────
# The dynamic /product/ page has fetched approved product_reviews for a while,
# but the 2,739 crawlable per-book pages never did -- so even once reviews start
# arriving they would be invisible on the pages people actually land on. Built
# as a function rather than inline template text so the JS can use normal
# braces; static_product_html is an f-string.
def live_reviews_block(slug: str) -> str:
    if not slug:
        return ""
    return """<section class="reviews" id="liveReviews" style="display:none">
  <div class="review-head">
    <h2>Customer Reviews</h2>
    <div class="score"><strong id="lrAvg"></strong><span id="lrCount"></span></div>
  </div>
  <div id="lrList"></div>
</section>
<script>
(function(){
  var S = """ + json.dumps(slug) + """;
  fetch('/.netlify/functions/get-reviews?slug=' + encodeURIComponent(S))
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){
      var rv = (d && d.reviews) || [];
      var sec = document.getElementById('liveReviews');
      if (!rv.length || !sec) return;
      var avg = (rv.reduce(function(a, r){ return a + (r.rating || 0); }, 0) / rv.length).toFixed(1);
      document.getElementById('lrAvg').textContent = avg + ' \u2605';
      document.getElementById('lrCount').textContent = rv.length + (rv.length > 1 ? ' reviews' : ' review');
      // textContent round-trip: comment and name are customer-authored.
      var esc = function(t){ var e = document.createElement('div'); e.textContent = t == null ? '' : t; return e.innerHTML; };
      document.getElementById('lrList').innerHTML = rv.map(function(r){
        var n = Math.max(0, Math.min(5, r.rating || 0));
        var stars = '\u2605'.repeat(n) + '\u2606'.repeat(5 - n);
        var date = new Date(r.created_at).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
        return '<div style="border-top:1px solid var(--border);padding:.9rem 0">'
          + '<div style="display:flex;justify-content:space-between;gap:1rem;font-size:.72rem">'
          + '<span class="stars">' + stars + '</span>'
          + '<span style="color:var(--muted)">' + date + '</span></div>'
          + '<div style="margin-top:.35rem;font-size:.78rem">' + esc(r.customer_name || 'Verified Buyer')
          + (r.verified_buyer ? ' <span style="color:#2f6e37;font-size:.6rem;letter-spacing:.1em">\u2713 VERIFIED PURCHASE</span>' : '')
          + '</div>'
          + (r.comment ? '<div style="margin-top:.4rem;line-height:1.7">' + esc(r.comment) + '</div>' : '')
          + '</div>';
      }).join('');
      sec.style.display = 'block';
    })
    .catch(function(){});
})();
</script>"""

# Legacy hardcoded slow-shipping list. Handling time is now per product in
# product_settings; this only seeds the baked page for titles nobody has set a
# value for yet, and the runtime override replaces it when one exists.
SLOW_SHIP_SLUGS_PY = {"off-campus-complete-5-book-collection-elle-kennedy"}


def static_product_html(book):
    handling_days = 1 if (book.get("slug") or "") in SLOW_SHIP_SLUGS_PY else 0
    title = html_escape(book.get("t", "Book"))
    author = html_escape(book.get("a") or "Various")
    cat = html_escape(book.get("cat") or "Books")
    price = html_escape(book.get("p") or "")
    orig = html_escape(book.get("op") or "")
    # Numeric forms for the data-* attributes. The display strings above carry a
    # currency symbol and separators, so anything reading a price out of the DOM
    # (the Google-discount script, the savings badge) needs the bare number.
    price_num = price_number(book)
    orig_num = _price_to_number(book.get("op"))
    save_pct = int(round((orig_num - price_num) / orig_num * 100)) if orig_num > price_num > 0 else 0
    desc = html_escape(book_description(book))
    canonical = product_abs_url(book["slug"])
    img = html_escape(absolute_img(book, large=True))
    back_img = html_escape(absolute_back_img(book))
    static_cover_class = "cover cover-gallery" if back_img else "cover"
    static_back_cover = f'<img src="{back_img}" alt="{title} back cover" loading="lazy" onclick="openLB(this.src,this.alt)" style="cursor:zoom-in"/>' if back_img else ""
    sample_pdf = book.get("pdf") or ""
    sample_pdf_pages = book.get("pdf_pages") or 0
    rating = html_escape(str(book.get("rating") or book.get("rating_value") or ""))
    review_count = html_escape(str(book.get("review_count") or ""))
    order_badge = html_escape(book.get("order_badge") or "")
    review_image = html_escape(book.get("review_image") or book.get("review_image_url") or "")
    review_images_list = book.get("review_images") or []
    review_video = html_escape(book.get("review_video") or book.get("review_video_url") or "")

    # ── Scarcity badge ─────────────────────────────────────────────────────
    is_scarce = bool(book.get("sc") or book.get("scarcity") or book.get("slug", "") in SCARCITY_SLUGS)
    scarcity_badge_html = (
        '<div class="prod-scarcity" style="display:inline-flex;align-items:center;gap:0.5rem;'
        'margin:0.6rem 0 0.2rem;padding:0.45rem 0.85rem;background:rgba(220,60,40,0.1);'
        'border:1px solid rgba(220,60,40,0.3);border-radius:2px;font-size:0.73rem;color:#f07060;">'
        '<span style="width:7px;height:7px;border-radius:50%;background:#e05040;'
        'box-shadow:0 0 0 3px rgba(220,60,40,0.25);display:inline-block;flex-shrink:0;"></span>'
        '🔥 Hurry! Only <strong>&nbsp;4 left</strong>&nbsp;in stock</div>'
    ) if is_scarce else ''

    # ── Description banners (Amazon A+-style) ─────────────────────────────
    desc_banners_list = book.get("description_banners") or []
    desc_banners_html = ""
    if desc_banners_list:
        desc_banners_html = '<div style="margin-top:1.4rem;">' + "".join(
            f'<img src="{html_escape(src)}" alt="{title} — product detail {i+1}" loading="lazy" '
            f'style="width:100%;display:block;margin-bottom:0.5rem;border-radius:4px;cursor:zoom-in" '
            f'onclick="openLB(this.src,this.alt)"/>'
            for i, src in enumerate(desc_banners_list)
        ) + '</div>'

    review_media_html = ""
    if review_count and (review_image or review_images_list or review_video):
        if len(review_images_list) > 1:
            imgs_html = "".join(
                f'<figure><img src="{html_escape(img)}" alt="{title} customer review photo {i+1}" loading="lazy" onclick="openLB(this.src,this.alt)" style="cursor:zoom-in"/><figcaption>Customer photo</figcaption></figure>'
                for i, img in enumerate(review_images_list)
            )
        else:
            imgs_html = f'<figure><img src="{review_image}" alt="{title} customer review photo" loading="lazy" onclick="openLB(this.src,this.alt)" style="cursor:zoom-in"/><figcaption>Customer photo shared after delivery</figcaption></figure>' if review_image else ""
        review_media_html = (
            '<div class="review-media">'
            + imgs_html
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
            f'style="display:inline-flex;align-items:center;gap:.55rem;font:600 .62rem \'Inter\',sans-serif;'
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
        "sku": book.get("sku", ""),
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
                f"font-family:'Inter',sans-serif\">{html_escape(initial)}</div>"
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
    # The strip + Instagram-style viewer are rendered client-side by /js/reels.js
    # from window.__IAC_REELS__. The strip loads NO video bytes (poster tiles
    # only); a reel streams from Supabase's CDN only when opened — zero Netlify
    # video bandwidth. "<\/" guards against a caption ever closing the script.
    # The section is emitted unconditionally: social_proof.json is empty by
    # design now (the strip is curated from the admin panel) and reels.js fetches
    # the live list at runtime. Gating the container on the build-time list left
    # admin-uploaded reels with nowhere to mount, so nothing ever appeared.
    reels_json = json.dumps(social_items[:12], ensure_ascii=False).replace("</", "<\\/")
    bkg_html = (
        f'<section data-iac-reels></section>'
        f'<script>window.__IAC_REELS__={reels_json};</script>'
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

    # ── Internal links for SEO juice flow (Round 4) ──────────────────────────
    _author_hub = author_hub_url_for(book)
    _author_link_html = ''
    if _author_hub:
        _auth_name = html_escape(book.get('a') or '')
        _auth_count = _AUTHOR_BOOK_COUNTS.get((book.get('a') or '').lower(), 0)
        _author_link_html = (
            f'<dt>Author</dt><dd>{_auth_name} · '
            f'<a href="{_author_hub}" style="color:var(--gold);text-decoration:underline">'
            f'View all {_auth_count} books by this author →</a></dd>'
        )

    _landing_url = landing_page_url_for(book)
    _landing_link_html = ''
    if _landing_url:
        _landing_label = _LANDING_LABEL.get(_landing_url, 'in this genre')
        _landing_link_html = (
            f' · <a href="{_landing_url}" style="color:var(--gold);text-decoration:underline">'
            f'Browse all {_landing_label} →</a>'
        )

    return f"""<!DOCTYPE html>
<html lang="{'hi' if is_hindi_book(book) else 'en'}">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>{title} | Buy Online @ ₹{int(price_number(book))} | Free Shipping | Ink &amp; Chai</title>
<meta name="description" content="{html_escape(book_description(book, 155))}"/>
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1"/>
<link rel="canonical" href="{canonical}"/>
<meta property="og:type" content="product"/>
<meta property="og:title" content="{title} | ₹{int(price_number(book))} | Ink &amp; Chai"/>
<meta property="og:description" content="{desc}"/>
<meta property="og:image" content="{img}"/>
<meta property="og:url" content="{canonical}"/>
<script type="application/ld+json">{product_json_ld(book)}</script>
<script type="application/ld+json">{product_faq_json_ld(book)}</script>
<script type="application/ld+json">{breadcrumb_json_ld(book)}</script>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=Lora:wght@400;500&family=Montserrat:wght@300;400;600;700&display=swap" rel="stylesheet"/>
<script>(function(){{var d=document.documentElement;try{{if(localStorage.getItem('iac_theme')!=='dark')d.setAttribute('data-theme','light')}}catch(e){{d.setAttribute('data-theme','light')}}}})();</script>
<style>
:root{{--bg:#0d0b08;--panel:#1c1916;--gold:#c9a84c;--cream:#f0e8d8;--muted:#a09080;--border:rgba(201,168,76,.18);--white:#faf7f2}}
html[data-theme="light"]{{--bg:#faf7f2;--panel:#fff;--gold:#7a5a12;--cream:#241c14;--muted:#4e4032;--border:rgba(138,106,31,.28);--white:#0d0b08}}
html{{overflow-x:hidden}} *{{box-sizing:border-box;min-width:0}} body{{margin:0;overflow-x:hidden;background:var(--bg);color:var(--cream);font-family:'Inter',sans-serif;font-weight:400}} a{{color:inherit}}
.promo{{padding:.62rem 1rem;text-align:center;border-bottom:1px solid var(--border);font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}} .promo strong{{color:var(--gold)}}
nav{{display:flex;align-items:center;justify-content:space-between;padding:1rem clamp(1rem,4vw,4rem);border-bottom:1px solid var(--border);background:rgba(13,11,8,.97);position:relative;z-index:5;backdrop-filter:blur(12px)}} html[data-theme="light"] nav{{background:rgba(250,247,242,.97)!important}} .logo{{font-family:"Cormorant Garamond",serif;font-size:1.5rem;color:var(--gold);text-decoration:none}} .back{{font-size:.62rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);text-decoration:none}}
.theme-btn{{background:transparent;border:1px solid var(--border);color:var(--gold);width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:.8rem;display:inline-flex;align-items:center;justify-content:center}}
.pdp-search{{display:flex;align-items:center;gap:.4rem;flex:1;max-width:400px;margin:0 1rem;background:rgba(201,168,76,.08);border:1px solid var(--border);border-radius:999px;padding:.26rem .26rem .26rem .9rem}}
.pdp-search input{{flex:1;background:transparent;border:0;color:var(--cream);font:inherit;font-size:.82rem;outline:none;min-width:0}}
.pdp-search input::placeholder{{color:var(--muted)}}
.pdp-search button{{padding:.42rem .72rem;border-radius:999px;border:1px solid var(--border);background:transparent;color:var(--gold);cursor:pointer;font-size:1rem;line-height:1;width:auto;height:auto;min-height:0}}
.pdp-search button:hover{{color:var(--gold-light,var(--gold));border-color:var(--gold)}}
@media(max-width:780px){{nav{{flex-wrap:wrap}} .pdp-search{{order:3;flex:1 0 100%;max-width:none;margin:.55rem 0 0}} .pdp-search input{{font-size:.95rem}} .pdp-search button{{padding:.5rem .85rem;width:auto;height:auto}}}}
.wrap{{max-width:1260px;margin:0 auto;padding:clamp(1.2rem,4vw,4rem) 1rem 4rem;display:grid;grid-template-columns:minmax(360px,.95fr) 1.05fr;gap:clamp(1.4rem,4vw,4rem);align-items:start}} .cover{{align-self:start;background:var(--panel);border:1px solid var(--border);padding:clamp(1rem,2.5vw,1.8rem);display:flex;align-items:center;justify-content:center;gap:.85rem;flex-wrap:wrap}} .cover img{{max-width:100%;max-height:560px;object-fit:contain;box-shadow:0 24px 64px rgba(0,0,0,.5)}} .cover-gallery img{{width:calc((100% - .85rem)/2);max-width:310px}} .cover-gallery img+img{{max-height:540px}}
.crumb{{font-size:.58rem;letter-spacing:.24em;text-transform:uppercase;color:var(--gold);margin-bottom:1rem}} h1{{font-family:"Cormorant Garamond",serif;font-size:clamp(2rem,5vw,3.4rem);font-weight:400;line-height:1.05;margin:.2rem 0 .6rem}} .author{{color:var(--muted);letter-spacing:.08em;margin-bottom:1rem}} .order-badge{{display:inline-flex;margin:0 0 1rem;border:1px solid rgba(138,106,31,.32);background:rgba(138,106,31,.08);color:var(--gold);font-size:.62rem;letter-spacing:.16em;text-transform:uppercase;padding:.42rem .75rem}} .rating-line{{display:flex;align-items:center;gap:.55rem;margin:0 0 1rem;color:var(--muted);font-size:.72rem}} .stars{{color:var(--gold);letter-spacing:.04em}} .price{{font-family:"Cormorant Garamond",serif;font-size:2.7rem;color:var(--gold);font-weight:600}} .orig{{color:var(--muted);text-decoration:line-through;margin-left:.8rem}} .price-row{{display:flex;align-items:baseline;flex-wrap:wrap;gap:.55rem}} .price-row .orig{{margin-left:0}} .save-badge{{font-size:.62rem;letter-spacing:.12em;text-transform:uppercase;font-weight:700;color:#6dbf6d;background:rgba(109,191,109,.1);border:1px solid rgba(109,191,109,.28);padding:.28rem .6rem;white-space:nowrap}} .save-badge[hidden]{{display:none}} .stock{{display:inline-block;margin:1rem 0;color:#7fd37f;border:1px solid rgba(127,211,127,.3);padding:.35rem .65rem;font-size:.7rem;letter-spacing:.14em;text-transform:uppercase}}
.ship-by-box{{display:flex;align-items:flex-start;gap:0.65rem;padding:0.75rem 1rem;background:rgba(109,191,109,0.07);border:1px solid rgba(109,191,109,0.22);border-radius:2px;margin:.9rem 0}}
.ship-by-icon{{font-size:1.15rem;line-height:1;flex-shrink:0;margin-top:0.1rem}}
.ship-by-text{{display:flex;flex-direction:column;gap:0.18rem}}
.ship-by-label{{font-size:0.58rem;letter-spacing:0.2em;text-transform:uppercase;color:#6dbf6d}}
.ship-by-date{{font-size:0.95rem;font-weight:600;color:#faf7f2;font-family:'Cormorant Garamond',serif}}
.ship-by-sub{{font-size:0.62rem;color:#a09080;margin-top:0.1rem}}
.eta-block{{margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid rgba(109,191,109,0.18)}}
.eta-head{{font-size:0.55rem;letter-spacing:0.2em;text-transform:uppercase;color:#6dbf6d;margin-bottom:0.28rem}}
.eta-row{{display:flex;justify-content:space-between;gap:1.2rem;font-size:0.66rem;line-height:1.75;color:#a09080}}
.eta-pin-row{{display:flex;gap:0.4rem;margin:0.35rem 0 0.25rem}}.eta-pin-input{{flex:1;min-width:0;padding:0.4rem 0.55rem;font-size:0.72rem;letter-spacing:0.06em;color:#f0e8d8;background:rgba(0,0,0,0.18);border:1px solid rgba(109,191,109,0.28);border-radius:8px}}.eta-pin-input:focus{{outline:none;border-color:#6dbf6d}}.eta-pin-btn{{padding:0.4rem 0.7rem;font-size:0.6rem;letter-spacing:0.14em;color:#0d0b08;background:#6dbf6d;border:0;border-radius:8px;cursor:pointer}}.eta-pin-btn:hover{{opacity:0.88}}.eta-pin-result{{font-size:0.7rem;line-height:1.65;color:#a09080;min-height:1rem}}.eta-pin-date strong{{color:#f0e8d8;font-weight:600}}.eta-pin-place{{opacity:0.8}}.eta-pin-cod{{margin-top:0.1rem;opacity:0.85}}.eta-pin-error{{color:#e0a060}}.eta-pin-loading{{opacity:0.7}}.eta-pin-geo{{margin:0 0 0.3rem;padding:0.3rem 0;font-size:0.64rem;letter-spacing:0.06em;color:#6dbf6d;background:none;border:0;cursor:pointer;text-align:left}}.eta-pin-geo:hover{{text-decoration:underline}}.eta-pin-geo:disabled{{opacity:0.5;cursor:default;text-decoration:none}}
.eta-zone{{white-space:nowrap}}
.eta-date{{color:#f0e8d8;font-weight:600;white-space:nowrap}}
.ship-by-limited{{font-size:0.58rem;letter-spacing:0.15em;text-transform:uppercase;color:#c9a84c;margin-top:0.15rem}}
/* Trust badges. Were four full-width emoji pills with a 24px radius — the
   stadium shape and the OS-drawn emoji are what dated them. Now a 2x2 grid of
   compact cards: a tinted round icon chip carrying an inline SVG (crisp at any
   size, inherits currentColor, identical on every platform, unlike emoji), a
   bold label, and a muted second line that adds the detail the old single line
   had no room for. */
.trust{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.6rem;margin:1.2rem 0}}
.trust>span{{display:flex;align-items:center;gap:.65rem;border:1px solid var(--border);
  background:linear-gradient(180deg,rgba(201,168,76,.07),rgba(201,168,76,.02));
  padding:.7rem .8rem;color:var(--cream);font-size:.78rem;border-radius:14px;
  box-shadow:inset 0 1px rgba(255,255,255,.05);transition:border-color .2s ease,transform .2s ease}}
.trust>span:hover{{border-color:rgba(201,168,76,.45);transform:translateY(-1px)}}
.trust .ti{{flex:0 0 auto;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;
  background:rgba(201,168,76,.12);color:var(--gold)}}
.trust .ti svg{{width:17px;height:17px;display:block}}
.trust .tt{{min-width:0;display:flex;flex-direction:column;gap:.1rem;line-height:1.25}}
.trust .tt b{{font-weight:600;font-size:.8rem;color:var(--cream)}}
.trust .tt i{{font-style:normal;font-size:.68rem;color:var(--muted)}}
.trust .tt a{{color:inherit;text-decoration:none;border-bottom:1px solid rgba(201,168,76,.4)}}
html[data-theme="light"] .trust>span{{background:linear-gradient(180deg,rgba(255,255,255,.7),rgba(255,255,255,.35))}} .actions{{display:grid;grid-template-columns:1fr 1fr;gap:.8rem;margin:1.3rem 0}} button,.btn{{font:700 .68rem Montserrat,sans-serif;letter-spacing:.2em;text-transform:uppercase;padding:1rem;border:1px solid var(--gold);cursor:pointer;text-align:center;text-decoration:none}} .primary{{background:var(--gold);color:var(--bg)}} .secondary{{background:transparent;color:var(--gold)}} .is-loading{{position:relative;color:transparent!important;pointer-events:none;opacity:.78}} .is-loading::after{{content:'';position:absolute;left:50%;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spinBtn .75s linear infinite;color:#fff}} .secondary.is-loading::after{{color:var(--gold)}} @keyframes spinBtn{{to{{transform:rotate(360deg)}}}}
.desc,.details{{border-top:1px solid var(--border);padding-top:1.2rem;margin-top:1.2rem;word-break:break-word;overflow-wrap:anywhere}} .desc{{font-family:Lora,Georgia,serif;color:var(--cream);font-size:1rem;line-height:1.85;letter-spacing:.005em;font-weight:400}} html[data-theme="light"] .desc{{color:#2f251b}} .details{{color:var(--muted);font-size:.9rem;line-height:1.8}} .label{{font-size:.66rem;letter-spacing:.24em;text-transform:uppercase;color:var(--gold);margin-bottom:.85rem;font-weight:700}} .details dl{{display:grid;grid-template-columns:120px 1fr;gap:.5rem 1rem}} .details dt{{color:var(--gold)}} .details dd{{margin:0;color:var(--cream)}}
.reviews{{border:1px solid var(--border);background:rgba(138,106,31,.055);padding:1.15rem;margin-top:1.3rem;color:var(--muted);line-height:1.7}} .review-head{{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start}} .review-head h2{{font-size:1.45rem;margin:.1rem 0 0}} .score{{text-align:right;flex-shrink:0}} .score strong{{display:block;font-family:"Cormorant Garamond",serif;font-size:2.2rem;color:var(--gold);line-height:.9}} .score span{{font-size:.62rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}} .review-media{{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:.8rem;margin-top:.9rem}} .review-media figure{{margin:0;border:1px solid var(--border);background:#fff;overflow:hidden}} .review-media img,.review-media video{{display:block;width:100%;height:240px;object-fit:cover;background:#f4efe7}} .review-media figcaption{{padding:.65rem .75rem;font-size:.65rem;letter-spacing:.08em;color:var(--muted)}}
@media(max-width:760px){{
  .wrap{{display:block;padding:.8rem 1rem 8rem}}
  .cover{{margin-bottom:1rem;padding:.7rem}}
  .cover img{{max-height:260px}}
  .cover-gallery img{{width:calc((100% - .5rem)/2);max-width:none}}
  h1{{font-size:clamp(1.5rem,5.5vw,2.2rem);margin:.1rem 0 .4rem}}
  .price{{font-size:2.1rem}}
  .trust{{grid-template-columns:repeat(2,minmax(0,1fr));gap:.5rem}}
  .trust>span{{padding:.6rem .55rem;gap:.5rem}}
  .trust .ti{{width:28px;height:28px}} .trust .ti svg{{width:15px;height:15px}}
  .trust .tt b{{font-size:.73rem}} .trust .tt i{{font-size:.62rem}}
  .actions{{position:fixed;left:0;right:0;bottom:0;z-index:9;margin:0;background:rgba(13,11,8,.98);padding:.75rem 1rem calc(.75rem + env(safe-area-inset-bottom));border-top:1px solid var(--border);box-shadow:0 -10px 26px rgba(60,40,10,.12)}}
  .desc{{font-size:.96rem;line-height:1.78}}
  .details{{font-size:.82rem;line-height:1.75}}
  .details dl{{grid-template-columns:80px 1fr}}
  .reviews{{padding:.9rem}}
  .review-head{{display:block}}
  .score{{text-align:left;margin-top:.6rem}}
  .review-media{{grid-template-columns:1fr}}
  .review-media img,.review-media video{{height:auto;max-height:360px;object-fit:contain}}
  .ship-by-box{{padding:.6rem .75rem}}
}}
@media(max-width:400px){{
  h1{{font-size:1.4rem}}
  .price{{font-size:1.8rem}}
  /* Narrowest phones: the second line is the first thing to go, so the label
     itself never has to shrink to an unreadable size. */
  .trust>span{{padding:.5rem .45rem;gap:.45rem}}
  .trust .ti{{width:26px;height:26px}} .trust .ti svg{{width:14px;height:14px}}
  .trust .tt b{{font-size:.68rem}} .trust .tt i{{display:none}}
  button,.btn{{padding:.85rem .4rem;font-size:.6rem;letter-spacing:.12em}}
  .details dl{{grid-template-columns:70px 1fr}}
}}
@media(max-width:1100px){{.also-grid{{grid-template-columns:repeat(4,1fr)!important}}}}
@media(max-width:640px){{.also-grid{{grid-template-columns:repeat(2,1fr)!important;gap:.7rem!important}}}}
html[data-theme="light"] .actions{{background:rgba(250,247,242,.98)}}
/* Liquid glass product-page refresh */
body{{
  background:
    linear-gradient(115deg,rgba(201,168,76,.08) 0%,transparent 32%,transparent 72%,rgba(201,168,76,.06) 100%),
    repeating-linear-gradient(90deg,rgba(201,168,76,.035) 0 1px,transparent 1px 86px),
    var(--bg);
}}
.promo{{
  width:min(920px,calc(100% - 24px));
  margin:.7rem auto .2rem;
  border:1px solid var(--border);
  border-radius:999px;
  background:rgba(250,247,242,.08);
  box-shadow:inset 0 1px rgba(255,255,255,.08);
  backdrop-filter:blur(18px) saturate(1.2);
}}
html[data-theme="light"] .promo{{background:rgba(250,247,242,.78);box-shadow:0 10px 28px rgba(70,52,24,.08),inset 0 1px rgba(255,255,255,.62)}}
nav{{
  width:min(1180px,calc(100% - 28px));
  margin:.75rem auto 0;
  border:1px solid var(--border);
  border-radius:999px;
  background:rgba(13,11,8,.7)!important;
  box-shadow:0 18px 55px rgba(0,0,0,.32),inset 0 1px rgba(255,255,255,.08);
  backdrop-filter:blur(24px) saturate(1.25);
}}
html[data-theme="light"] nav{{background:rgba(250,247,242,.74)!important;box-shadow:0 18px 55px rgba(70,52,24,.12),inset 0 1px rgba(255,255,255,.62)}}
/* .trust span is deliberately not here — it sets its own 14px radius. At 24px
   on a short two-line card the corners meet in the middle and read as a pill. */
.cover,.reviews,.insta-trust,.desc,.details,.ship-by-box{{
  border-radius:24px;
  box-shadow:inset 0 1px rgba(255,255,255,.05);
}}
.cover{{background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02));box-shadow:0 24px 70px rgba(0,0,0,.18),inset 0 1px rgba(255,255,255,.06)}}
html[data-theme="light"] .cover{{background:rgba(255,255,255,.58);box-shadow:0 24px 70px rgba(70,52,24,.1),inset 0 1px rgba(255,255,255,.74)}}
.stock,.order-badge,.theme-btn,.pdp-cart-btn,button,.btn,.btn-checkout,.qty-btn{{border-radius:999px}}
.actions button{{min-height:52px;box-shadow:inset 0 1px rgba(255,255,255,.12);transition:transform .2s ease,filter .2s ease,box-shadow .2s ease}}
.actions button:hover{{transform:translateY(-1px);filter:brightness(1.05)}}
.primary{{box-shadow:0 14px 30px rgba(201,168,76,.18),inset 0 1px rgba(255,255,255,.18)}}
.secondary{{background:rgba(201,168,76,.06)}}
.cart-overlay{{background:rgba(13,11,8,.38);backdrop-filter:blur(8px)}}
.cart-sidebar{{
  top:14px;right:14px;bottom:14px;
  border:1px solid var(--border);
  border-radius:34px;
  background:rgba(20,18,16,.76);
  box-shadow:0 24px 70px rgba(0,0,0,.42),inset 0 1px rgba(255,255,255,.08);
  backdrop-filter:blur(24px) saturate(1.25);
  overflow:hidden;
}}
html[data-theme="light"] .cart-sidebar{{background:#fffdfa;box-shadow:0 24px 70px rgba(70,52,24,.14),inset 0 1px rgba(255,255,255,.62)}}
.cart-header,.cart-footer{{background:rgba(255,255,255,.06);backdrop-filter:blur(14px)}}
html[data-theme="light"] .cart-header,html[data-theme="light"] .cart-footer{{background:rgba(255,255,255,.42)}}
@media(max-width:760px){{
  .promo{{width:calc(100% - 20px);margin:.45rem auto .1rem;border-radius:999px;white-space:normal;line-height:1.45}}
  nav{{width:calc(100% - 18px);margin:.45rem auto 0;border-radius:28px;padding:.7rem .85rem}}
  .wrap{{padding-top:1.05rem;padding-bottom:7.6rem}}
  .cover,.reviews,.desc,.details{{border-radius:24px}}
  .actions{{
    left:12px;right:12px;bottom:10px;
    display:grid;grid-template-columns:1fr 1fr;gap:.6rem;
    border:1px solid var(--border);
    border-radius:30px;
    background:rgba(13,11,8,.72);
    padding:.6rem .6rem calc(.6rem + env(safe-area-inset-bottom));
    box-shadow:0 -12px 38px rgba(0,0,0,.38),inset 0 1px rgba(255,255,255,.08);
    backdrop-filter:blur(24px) saturate(1.35);
  }}
  html[data-theme="light"] .actions{{background:rgba(250,247,242,.76);box-shadow:0 -12px 38px rgba(70,52,24,.16),inset 0 1px rgba(255,255,255,.64)}}
  .actions button{{min-height:52px;padding:.9rem .45rem;font-size:.6rem;letter-spacing:.14em}}
  .cart-sidebar{{inset:10px 10px calc(86px + env(safe-area-inset-bottom));width:auto;border-radius:28px}}
}}
.insta-trust{{display:flex;align-items:center;gap:.75rem;padding:.7rem .9rem;margin:.2rem 0 .6rem;background:linear-gradient(135deg,rgba(131,58,180,.08),rgba(253,29,29,.06),rgba(252,176,69,.08));border:1px solid rgba(195,80,170,.25);border-radius:3px;text-decoration:none;color:inherit;transition:border-color .2s,background .2s}}
.insta-trust:hover{{border-color:rgba(195,80,170,.55);background:linear-gradient(135deg,rgba(131,58,180,.14),rgba(253,29,29,.1),rgba(252,176,69,.12))}}
.insta-trust-icon{{font-size:1.3rem;flex-shrink:0}}
.insta-trust-text{{display:flex;flex-direction:column;gap:.1rem;flex:1;min-width:0}}
.insta-trust-title{{font-size:.75rem;font-weight:600;color:var(--cream);letter-spacing:.01em}}
.insta-trust-sub{{font-size:.6rem;color:#a09080;letter-spacing:.03em}}
.insta-trust-arrow{{font-size:.9rem;color:rgba(195,80,170,.7);flex-shrink:0}}
.pdp-cred{{display:flex;flex-wrap:wrap;gap:.4rem;margin:.6rem 0 .3rem}}
.cred-chip{{display:inline-flex;align-items:center;gap:.35rem;font-size:.62rem;font-weight:600;letter-spacing:.02em;padding:.34rem .62rem;border:1px solid var(--border);border-radius:999px;color:var(--cream);background:rgba(255,255,255,.02)}}
.cred-chip svg{{flex-shrink:0}}
.cred-meta{{border-color:rgba(24,119,242,.45);background:rgba(24,119,242,.1)}}
.meta-verified{{display:block;margin:.6rem 0 .3rem;border:1px solid var(--border);border-radius:8px;overflow:hidden;text-decoration:none;background:#fff;max-width:420px}}
.meta-verified img{{display:block;width:100%;height:auto}}
.meta-verified-cap{{display:flex;align-items:center;gap:.4rem;padding:.5rem .75rem;font-size:.68rem;font-weight:600;letter-spacing:.02em;color:#fff;background:#1877F2}}
/* ── Nav cart button + sidebar (product page) ── */
.pdp-cart-btn{{position:relative;background:transparent;border:1px solid var(--border);color:var(--gold);width:38px;height:38px;border-radius:50%;cursor:pointer;font-size:1rem;display:inline-flex;align-items:center;justify-content:center;transition:all .25s;padding:0}}
.pdp-cart-btn:hover{{background:var(--gold);color:var(--bg);transform:translateY(-1px)}}
.pdp-cart-badge{{position:absolute;top:-6px;right:-6px;background:var(--gold);color:var(--bg);border-radius:50%;min-width:18px;height:18px;font-size:.58rem;font-weight:600;font-family:'Inter',sans-serif;display:inline-flex;align-items:center;justify-content:center;padding:0 4px;line-height:1;border:1px solid var(--bg)}}
.pdp-cart-btn:hover .pdp-cart-badge{{background:var(--bg);color:var(--gold);border-color:var(--gold)}}
@keyframes pdpBadgePop{{0%{{transform:scale(.4);opacity:0}}60%{{transform:scale(1.3)}}100%{{transform:scale(1);opacity:1}}}}
.pdp-cart-badge.bump{{animation:pdpBadgePop .4s cubic-bezier(.34,1.56,.64,1)}}
.cart-overlay{{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9990;opacity:0;pointer-events:none;transition:opacity .35s}}
.cart-overlay.show{{opacity:1;pointer-events:all}}
.cart-sidebar{{position:fixed;top:0;right:0;bottom:0;width:min(420px,100vw);background:var(--panel);border-left:1px solid var(--border);z-index:10001;transform:translateX(100%);transition:transform .35s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column}}
.cart-sidebar.open{{transform:translateX(0)}}
.cart-header{{display:flex;justify-content:space-between;align-items:center;padding:1.6rem 1.8rem;border-bottom:1px solid var(--border)}}
.cart-title{{font-family:'Cormorant Garamond',serif;font-size:1.4rem;font-weight:400;color:var(--white)}}
.cart-close{{background:none;border:none;color:var(--muted);font-size:1.3rem;cursor:pointer;padding:.2rem .4rem;transition:color .2s}}
.cart-close:hover{{color:var(--gold)}}
.cart-body{{flex:1;overflow-y:auto;padding:1.2rem 1.8rem}}
.cart-empty{{text-align:center;padding:4rem 1rem;color:var(--muted);font-size:.78rem;letter-spacing:.08em}}
.cart-empty-icon{{font-size:2.5rem;margin-bottom:1rem;opacity:.3}}
.cart-item{{display:flex;gap:1rem;padding:1.2rem 0;border-bottom:1px solid var(--border);transition:background .2s ease}}
.cart-item:hover{{background:rgba(201,168,76,.04)}}
.cart-item-img{{width:64px;flex-shrink:0;aspect-ratio:2/3;background:var(--bg);overflow:hidden}}
.cart-item-img img{{width:100%;height:100%;object-fit:cover}}
.cart-item-img-placeholder{{width:100%;height:100%;background:linear-gradient(135deg,#1a0a00,#3a1500)}}
.cart-item-info{{flex:1;min-width:0}}
.cart-item-title{{font-family:'Cormorant Garamond',serif;font-size:.95rem;color:var(--cream);line-height:1.3;margin-bottom:.2rem;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}}
.cart-item-author{{font-size:.6rem;color:var(--muted);letter-spacing:.08em;margin-bottom:.4rem}}
.cart-item-price{{font-family:'Cormorant Garamond',serif;font-size:1rem;color:var(--gold);margin-bottom:.5rem}}
.cart-item-controls{{display:flex;align-items:center;gap:.5rem}}
.qty-btn{{background:var(--bg);border:1px solid var(--border);color:var(--cream);width:24px;height:24px;cursor:pointer;font-size:.9rem;display:flex;align-items:center;justify-content:center;transition:all .2s}}
.qty-btn:hover{{background:var(--gold);color:var(--bg);border-color:var(--gold)}}
.qty-num{{font-size:.78rem;color:var(--cream);min-width:20px;text-align:center}}
.cart-remove{{background:none;border:none;color:var(--muted);font-size:.6rem;letter-spacing:.12em;cursor:pointer;text-transform:uppercase;margin-left:.5rem;transition:color .2s}}
.cart-remove:hover{{color:#e05a5a}}
.cart-footer{{padding:1.4rem 1.8rem;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:.8rem}}
.cart-total-row{{display:flex;justify-content:space-between;align-items:baseline}}
.cart-total-label{{font-size:.6rem;letter-spacing:.22em;text-transform:uppercase;color:var(--muted)}}
.cart-total-amount{{font-family:'Cormorant Garamond',serif;font-size:1.5rem;color:var(--gold);font-weight:600}}
.btn-checkout{{width:100%;font-family:'Inter',sans-serif;font-size:.65rem;letter-spacing:.25em;text-transform:uppercase;padding:1rem;background:var(--gold);color:var(--bg);border:none;cursor:pointer;font-weight:500;transition:all .3s}}
.btn-checkout:hover{{filter:brightness(1.08)}}
</style>
</head>
<body>
<div class="promo"><strong>Free delivery on ₹499+</strong> · Prepaid offers up to <strong>15% off</strong> · COD available</div>
<nav><a class="logo" href="/">Ink &amp; Chai</a><form class="pdp-search" action="/" method="get" role="search"><input type="search" name="q" placeholder="Search books&hellip;" aria-label="Search books" autocomplete="off"/><button type="submit" aria-label="Search">&#128269;</button></form><div style="display:flex;align-items:center;gap:1rem"><a class="back" href="/books/">All Books</a><button class="pdp-cart-btn" id="pdpCartBtn" onclick="if(window.openCart)openCart()" aria-label="Open cart" title="Cart">🛒<span class="pdp-cart-badge" id="cartBadge" style="display:none">0</span></button><button class="theme-btn" onclick="(function(){{var d=document.documentElement;var t=d.getAttribute('data-theme');var n=t==='light'?null:'light';if(n)d.setAttribute('data-theme',n);else d.removeAttribute('data-theme');try{{localStorage.setItem('iac_theme',n||'dark')}}catch(e){{}}}})()" title="Toggle theme">☀</button></div></nav>
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
    <div class="price-row"><span class="price" data-product-price="{price_num:g}" style="opacity:0;transition:opacity 0.15s">{price}</span>{f'<span class="orig" data-product-original-price="{orig_num:g}" style="opacity:0;transition:opacity 0.15s">{orig}</span>' if orig else ''}{f'<span class="save-badge" data-save-badge style="opacity:0;transition:opacity 0.15s">{save_pct}% off</span>' if save_pct else '<span class="save-badge" data-save-badge hidden></span>'}</div>
    {scarcity_badge_html if scarcity_badge_html else '<span class="stock">In Stock</span>'}
    <div id="staticShipBy"></div>
    <div class="trust"><span><span class="ti" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h11v9H3z"/><path d="M14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.8"/><circle cx="17.5" cy="18" r="1.8"/></svg></span><span class="tt"><b>Delivery in 2-5 days</b><i>Shipped across India</i></span></span><span><span class="ti" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/></svg></span><span class="tt"><b>Cash on delivery</b><i>Pay when it arrives</i></span></span><span><span class="ti" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/><path d="M6 14.5h4"/></svg></span><span class="tt"><b>UPI, cards, net banking</b><i>Secure checkout</i></span></span><span><span class="ti" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7.5 3v5.5c0 4.3-3.1 7.7-7.5 9-4.4-1.3-7.5-4.7-7.5-9V6z"/><path d="M9 12l2 2 4-4"/></svg></span><span class="tt"><b>7-day replacement</b><i><a href="#" onclick="event.preventDefault();openReturnVideo();" style="cursor:pointer">Watch how it works &#9654;</a></i></span></span></div>
    <div class="pdp-cred" aria-label="Store credibility"><span class="cred-chip">📦 25,000+ orders fulfilled</span></div> <a href="https://www.instagram.com/inkandchai.in/" target="_blank" rel="noopener" class="meta-verified" title="Ink &amp; Chai on Instagram — Meta Verified Business"><img src="/images/meta-verified-inkandchai.webp" alt="Ink &amp; Chai is a Meta Verified Business on Instagram — 28.8K followers" width="760" height="368" loading="lazy"/><span class="meta-verified-cap"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="#fff" d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.68.88-3.34 2.19c-1.39-.46-2.9-.2-3.91.81s-1.26 2.52-.81 3.91c-1.31.67-2.19 1.91-2.19 3.34s.88 2.67 2.19 3.34c-.45 1.39-.2 2.9.81 3.91s2.52 1.26 3.91.81c.66 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34z"/><path fill="#1877F2" d="M10.09 15.42l-3.8-3.79 1.41-1.42 2.39 2.38 5.62-5.62 1.41 1.42z"/></svg>Meta Verified Business →</span></a>
    <a href="https://www.instagram.com/inkandchai.in/" target="_blank" rel="noopener" class="insta-trust">
      <span class="insta-trust-icon">📸</span>
      <span class="insta-trust-text">
        <span class="insta-trust-title">Still Doubtful? Check our Bookstagram</span>
        <span class="insta-trust-sub">@inkandchai.in · Real unboxings from real customers</span>
      </span>
      <span class="insta-trust-arrow">→</span>
    </a>
    <div class="actions">
      <button class="secondary" onclick="addBookToCart(this)">Add to Cart</button>
      <button class="primary" onclick="buyNowBook(this)">Buy Now</button>
    </div>
    <div class="desc"><div class="label">About this book</div>{desc}</div>
{desc_banners_html}
{review_html}
    <div class="details"><div class="label">Details</div><dl><dt>Category</dt><dd>{cat}{_landing_link_html}</dd>{_author_link_html}<dt>Publisher</dt><dd>{html_escape(book.get('pub') or 'Ink & Chai')}</dd><dt>ISBN</dt><dd>{html_escape(book.get('isbn') or 'Available on request')}</dd><dt>Sold by</dt><dd>Ink &amp; Chai</dd></dl></div>
  </section>
</main>
{reviews_html}
{live_reviews_block(book.get('slug') or '')}
{bkg_html}
{also_like_html}

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
      <a id="pdfDl" href="#" download target="_blank" rel="noopener" style="font:600 .55rem 'Inter',sans-serif;letter-spacing:.18em;text-transform:uppercase;padding:.5rem .85rem;background:transparent;color:#c9a84c;border:1px solid rgba(201,168,76,.4);text-decoration:none;cursor:pointer">⬇ Download</a>
      <button onclick="closePdf()" style="font:600 .55rem 'Inter',sans-serif;letter-spacing:.18em;text-transform:uppercase;padding:.5rem .85rem;background:rgba(201,168,76,.12);color:#c9a84c;border:1px solid #c9a84c;cursor:pointer">✕ Close</button>
    </div>
    <div id="pdfPages" style="flex:1;overflow-y:auto;padding:1.2rem;display:flex;flex-direction:column;align-items:center;gap:1rem;background:#1a1410">
      <div id="pdfLoading" style="color:#a09080;font-size:.85rem;padding:3rem 1rem;text-align:center">Loading sample pages...</div>
    </div>
  </div>
</div>

<!-- Cart sidebar (slides in from right when items are added) -->
<div class="cart-overlay" id="cartOverlay" onclick="closeCart()"></div>
<div class="cart-sidebar" id="cartSidebar">
  <div class="cart-header">
    <span class="cart-title">Your Cart</span>
    <button class="cart-close" onclick="closeCart()" aria-label="Close cart">✕</button>
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
    <button class="btn-checkout" onclick="window.location.href='/checkout/'">Checkout →</button>
  </div>
</div>

<script src="/js/cart.js"></script>
<script src="/js/google-discount.js"></script>
<script src="/js/search-suggest.js" defer></script>
<script src="/js/summer-sale.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js" defer></script>
<script>
let currentItem = {cart_item};
function priceText(value) {{
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? '₹ ' + n.toLocaleString('en-IN', {{ maximumFractionDigits: 0 }}) : '';
}}
function priceValue(sel) {{
  const el = document.querySelector(sel);
  if (!el) return 0;
  // Prefer the numeric attribute; fall back to the rendered text for any page
  // that was generated before the attribute carried a value.
  const attr = Number(el.getAttribute(sel === '[data-product-price]' ? 'data-product-price' : 'data-product-original-price'));
  if (Number.isFinite(attr) && attr > 0) return attr;
  return Number(String(el.textContent || '').replace(/[^0-9.]/g, '')) || 0;
}}
// Percentage off MRP, recomputed from whatever the two price elements currently
// say — so it stays correct after an admin price override or a Google discount.
function syncSaveBadge() {{
  const badge = document.querySelector('[data-save-badge]');
  if (!badge) return;
  const sale = priceValue('[data-product-price]');
  const mrp = priceValue('[data-product-original-price]');
  if (!(mrp > sale && sale > 0)) {{ badge.hidden = true; return; }}
  badge.textContent = Math.round((mrp - sale) / mrp * 100) + '% off';
  badge.hidden = false;
}}
function revealPrice() {{
  syncSaveBadge();
  document.querySelectorAll('[data-product-price],[data-product-original-price],[data-save-badge]').forEach(el => {{
    el.style.opacity = '1';
  }});
}}
// Builds (or removes) the green publisher-sourced panel on a static catalogue
// page. The discount line quotes the live price against the live MRP, so it
// stays honest after a price override rather than repeating a baked number.
function applyPublisherSourcedBadge(on) {{
  const existing = document.querySelector('.publisher-sourced-box');
  if (on) currentItem._publisher_sourced = true;
  else delete currentItem._publisher_sourced;
  if (!on) {{ if (existing) existing.remove(); return; }}
  const anchor = document.querySelector('main .desc');
  if (!anchor || !anchor.parentNode) return;
  const price = priceValue('[data-product-price]');
  const mrp = priceValue('[data-product-original-price]');
  let offText = '';
  if (price > 0 && mrp > price) {{
    const off = Math.round((1 - price / mrp) * 1000) / 10;
    if (off >= 1) offText = ', at ' + (off % 1 === 0 ? off.toFixed(0) : off.toFixed(1)) + '% off';
  }}
  const box = existing || document.createElement('div');
  box.className = 'publisher-sourced-box';
  box.setAttribute('style', 'border:1px solid rgba(110,170,110,0.35);background:linear-gradient(135deg,rgba(110,170,110,0.10),rgba(201,168,76,0.05));padding:1rem 1.2rem;border-radius:2px;margin-bottom:0.9rem;display:flex;gap:0.85rem;align-items:flex-start;');
  box.innerHTML = '<div style="font-size:1.4rem;line-height:1;">📚</div><div>'
    + '<div style="font-size:0.56rem;letter-spacing:0.28em;text-transform:uppercase;color:#6daa6d;margin-bottom:0.35rem;font-weight:600;">Genuine — Publisher Sourced</div>'
    + '<div style="font-size:0.76rem;color:var(--cream);line-height:1.65;">This title is sourced <strong>directly from the publisher</strong> — no third-party resellers, no piracy. Original copy, MRP printed on the back'
    + offText + '.</div>'
    + '<div style="font-size:0.72rem;color:var(--cream-dim);line-height:1.65;margin-top:0.45rem;"><strong style="color:var(--gold);">🧾 GST invoice available</strong> on request — reply to your order confirmation email with your GSTIN.</div>'
    + '</div>';
  if (!existing) anchor.parentNode.insertBefore(box, anchor);
}}
async function applyRuntimeProductOverride() {{
  try {{
    const slug = location.pathname.split('/').filter(Boolean)[1] || '';
    // Ask for THIS slug only. The whole-catalogue feed is ~250 KB and cached for
    // an hour, so a product page was both downloading the entire catalogue to
    // read one row and showing an hour-old price after an admin edit. The
    // single-slug branch is a few hundred bytes and carries a 5-minute TTL.
    const key = String(slug || '').toLowerCase();
    const res = await fetch('/.netlify/functions/get-product-overrides?slug=' + encodeURIComponent(key), {{ cache: 'default' }});
    if (!res.ok) {{ revealPrice(); return; }}
    const data = await res.json();
    const override = (data.overrides || []).find(o => String(o.slug || '').toLowerCase() === key);
    if (!override) {{ revealPrice(); return; }}
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
        el.setAttribute('data-product-price', String(Number(override.price_inr) || 0));
        el.setAttribute('data-live-override', 'price');
      }});
    }}
    if (override.original_price_inr !== null && override.original_price_inr !== undefined) {{
      const mrpText = priceText(override.original_price_inr);
      let origEls = document.querySelectorAll('[data-product-original-price], .orig, .prod-orig');
      if (origEls.length === 0) {{
        // Book had no MRP in catalogue — create the element next to the sale price
        const priceEl = document.querySelector('[data-product-price], .price');
        if (priceEl && priceEl.parentNode) {{
          const span = document.createElement('span');
          span.className = 'orig';
          span.setAttribute('data-product-original-price', '');
          priceEl.parentNode.insertBefore(span, priceEl.nextSibling);
          origEls = [span];
        }}
      }}
      origEls.forEach(el => {{
        el.textContent = mrpText;
        el.setAttribute('data-product-original-price', String(Number(override.original_price_inr) || 0));
        el.setAttribute('data-live-override', 'original-price');
      }});
    }}
    // "Genuine — Publisher Sourced" badge. Catalogue pages are baked without it,
    // so when the admin turns it on the box has to be built here; turning it off
    // removes whatever a previous run inserted. Idempotent — repeated calls (the
    // page revalidates overrides) neither duplicate nor flicker the box.
    applyPublisherSourcedBadge(override.publisher_sourced === true);
    // Per-product handling time. The box was already painted with the baked
    // value; repaint only when the admin set something different, so the common
    // case costs nothing and the dates never flicker.
    if (override.handling_days !== null && override.handling_days !== undefined) {{
      var handling = Math.max(0, Math.min(30, parseInt(override.handling_days, 10) || 0));
      if (handling !== window.__iacHandlingDays) {{
        window.__iacHandlingDays = handling;
        renderStaticShipBy(handling);
      }}
    }}
    // Manual stock: <=0 means sold out → replace Buy with a "Coming Soon" box and
    // flag the buy handlers so nothing can be added to cart. null/absent = in stock.
    if (override.stock_qty !== null && override.stock_qty !== undefined && Number(override.stock_qty) <= 0) {{
      window.__soldOut = true;
      const actions = document.querySelector('.actions');
      if (actions) actions.innerHTML = '<div style="flex:1;padding:1rem 1.2rem;border:1px solid rgba(232,160,48,0.4);background:rgba(232,160,48,0.08);text-align:center;"><div style="font-size:0.62rem;letter-spacing:0.28em;text-transform:uppercase;color:#e8a030;font-weight:700;">Coming Soon</div><div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem;">Currently out of stock — check back soon.</div></div>';
      const stockEl = document.querySelector('.stock');
      if (stockEl) {{ stockEl.textContent = 'Coming Soon'; stockEl.style.color = '#e8a030'; stockEl.style.borderColor = 'rgba(232,160,48,0.4)'; }}
    }}
  }} catch (err) {{
    console.warn('Product override unavailable:', err.message);
  }} finally {{
    revealPrice();
  }}
}}
function setBtnLoading(btn,on) {{
  if (!btn) return;
  btn.classList.toggle('is-loading', !!on);
  btn.disabled = !!on;
}}
// Meta events for the static product page. These have to live here rather than
// in cart.js: addBookToCart/buyNowBook write akshar_cart themselves and never
// call cart.js's addToCart, so the copy over there is never reached on a PDP —
// which is exactly the page where a view and an add matter most.
// content_ids uses currentItem.id, the same value the cart stores and the
// checkout later reports, so a view, an add and a purchase all name the product
// identically; otherwise Meta cannot connect them or match the catalogue.
function metaProductParams() {{
  return {{
    content_ids: [String(currentItem.id || '')],
    content_type: 'product',
    content_name: String(currentItem.title || ''),
    currency: 'INR',
    value: Number(currentItem.price) || 0,
  }};
}}
let _iacViewed = false;
function reportViewContent() {{
  // Fires after the override fetch settles so the title and price reported are
  // the ones the customer actually saw, with a timeout in case that fetch hangs.
  if (_iacViewed || !window.iacMeta) return;
  _iacViewed = true;
  window.iacMeta('ViewContent', metaProductParams());
}}
function addBookToCart(btn) {{
  if (window.__soldOut) {{ if (window.showToast) showToast('Out of stock — Coming Soon'); else alert('This book is currently out of stock (Coming Soon).'); return; }}
  if (window.stopReaderActivity) stopReaderActivity();
  setBtnLoading(btn, true);
  localStorage.removeItem('iac_buy_now_cart');
  if (window.iacMeta) window.iacMeta('AddToCart', metaProductParams());
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
  if (window.__soldOut) {{ if (window.showToast) showToast('Out of stock — Coming Soon'); else alert('This book is currently out of stock (Coming Soon).'); return; }}
  if (window.stopReaderActivity) stopReaderActivity();
  setBtnLoading(btn, true);
  // Buy Now is an add too — it just skips the basket on the way to checkout.
  if (window.iacMeta) window.iacMeta('AddToCart', metaProductParams());
  const item = {{ ...currentItem }};
  localStorage.setItem('iac_buy_now_cart', JSON.stringify([item]));
  setTimeout(() => {{ location.href='/checkout/?buynow=1'; }}, 220);
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
// ── Returns explainer video lightbox (iframe lazy-mounted on first open) ────
function openReturnVideo() {{
  if (document.getElementById('returnVideoLB')) return;
  const lb = document.createElement('div');
  lb.id = 'returnVideoLB';
  lb.style.cssText = 'position:fixed;inset:0;background:rgba(13,11,8,0.94);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;z-index:10700;padding:1.2rem;';
  lb.innerHTML =
    '<div style="position:relative;width:min(820px,96vw);background:#0d0b08;border:1px solid rgba(201,168,76,0.3);border-radius:12px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,0.6);">'
    +   '<button onclick="closeReturnVideo()" aria-label="Close video" style="position:absolute;top:0.6rem;right:0.6rem;z-index:2;background:rgba(13,11,8,0.7);border:1px solid rgba(201,168,76,0.3);color:#c9a84c;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:1rem;line-height:1;">✕</button>'
    +   '<div style="padding:1rem 1.4rem 0.4rem;font-family:Cormorant Garamond,serif;font-size:1.25rem;color:#c9a84c;font-style:italic;">How returns work — 30 seconds</div>'
    +   '<div style="position:relative;padding-bottom:56.25%;height:0;">'
    +     '<iframe src="https://embed.app.guidde.com/playbooks/1UdjQpZngy38d35GLotezC?mode=videoOnly" title="Returning a book on Ink &amp; Chai takes 30 seconds." frameborder="0" referrerpolicy="unsafe-url" allowfullscreen="true" allow="clipboard-write" sandbox="allow-popups allow-popups-to-escape-sandbox allow-scripts allow-forms allow-same-origin allow-presentation" style="position:absolute;top:0;left:0;width:100%;height:100%;"></iframe>'
    +   '</div>'
    +   '<div style="padding:0.85rem 1.4rem;font-size:0.72rem;color:#a09080;text-align:center;">Prefer reading? <a href="/return-policy/" style="color:#c9a84c;text-decoration:underline;">Full return policy →</a></div>'
    + '</div>';
  lb.addEventListener('click', e => {{ if (e.target === lb) closeReturnVideo(); }});
  document.body.appendChild(lb);
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', returnVideoEsc);
}}
function returnVideoEsc(e) {{ if (e.key === 'Escape') closeReturnVideo(); }}
function closeReturnVideo() {{
  const lb = document.getElementById('returnVideoLB');
  if (lb) lb.remove();
  document.body.style.overflow = '';
  document.removeEventListener('keydown', returnVideoEsc);
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
// ── Ship-by date + delivery estimate ─────────────────────────────────────────
// Cutoff is 03:00 IST — the nightly courier manifest closes then. Before 03:00
// the order still makes that morning's dispatch; from 03:00 it waits a day.
// Handling time is per product. The baked value below is the fallback for the
// old hardcoded slow-shipping list; applyRuntimeProductOverride re-renders this
// box when product_settings.handling_days says something different.
window.__iacHandlingDays = {handling_days};
function renderStaticShipBy(handling) {{
  handling = Math.max(0, Math.min(30, parseInt(handling, 10) || 0));
  var CUTOFF = 3;
  var ZONES = [
    ['Delhi NCR', 1],
    ['Nearby states', 2],
    ['Rest of India', 3]
  ];
  var nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  var h = nowIST.getUTCHours();
  var days = (h < CUTOFF ? 0 : 1) + handling;
  function addDays(d, n) {{ return new Date(d.getTime() + n * 86400000); }}
  function fmt(d, w) {{
    return new Intl.DateTimeFormat('en-IN', {{
      weekday: w, day: 'numeric', month: w === 'long' ? 'long' : 'short', timeZone: 'UTC'
    }}).format(d);
  }}
  var shipDate = addDays(nowIST, days);
  var sub = handling > 0
    ? 'Allow ' + handling + ' extra ' + (handling === 1 ? 'day' : 'days') + ' before dispatch'
    : (days === 0 ? 'Order now and it is dispatched today' : 'Order now to get it dispatched tomorrow');
  var limited = handling > 0 ? '<div class="ship-by-limited">⚡ Limited stock</div>' : '';
  var rows = ZONES.map(function (z) {{
    return '<div class="eta-row"><span class="eta-zone">' + z[0] + '</span>'
      + '<span class="eta-date">' + fmt(addDays(shipDate, z[1]), 'short') + '</span></div>';
  }}).join('');
  var el = document.getElementById('staticShipBy');
  if (el) el.innerHTML =
    '<div class="ship-by-box">'
    + '<div class="ship-by-icon">📦</div>'
    + '<div class="ship-by-text">'
    + '<div class="ship-by-label">Ships by</div>'
    + '<div class="ship-by-date">' + fmt(shipDate, 'long') + '</div>'
    + '<div class="ship-by-sub">' + sub + '</div>'
    + limited
    + '<div class="eta-block" data-delivery-eta' + (handling > 0 ? ' data-extra-days="' + handling + '"' : '')
    + '><div class="eta-head">Estimated delivery</div>' + rows + '</div>'
    + '</div></div>';
  if (window.iacDeliveryEtaInit) window.iacDeliveryEtaInit();
}}
renderStaticShipBy(window.__iacHandlingDays);
applyRuntimeProductOverride().then(reportViewContent, reportViewContent);
setTimeout(reportViewContent, 3000);
</script>
<script src="/js/delivery-estimate.js" defer></script>
<!-- #InkAndChaiBookstagram reels: light poster strip + Instagram-style viewer.
     Loads video only when a reel is opened, and only the active one. -->
<script src="/js/reels.js" defer></script>
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
<style>:root{{--bg:#0d0b08;--gold:#c9a84c;--cream:#f0e8d8;--muted:#a09080;--border:rgba(201,168,76,.2)}}*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--cream);font-family:'Inter',Arial,sans-serif}}nav{{padding:1rem clamp(1rem,4vw,4rem);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:1rem;align-items:center}}a{{color:inherit;text-decoration:none}}.logo{{font-family:serif;font-size:1.5rem;color:var(--gold)}}.links{{display:flex;gap:1rem;flex-wrap:wrap;color:var(--muted);font-size:.7rem;letter-spacing:.12em;text-transform:uppercase}}main{{max-width:1180px;margin:auto;padding:clamp(2rem,6vw,5rem) 1rem}}.eyebrow{{color:var(--gold);letter-spacing:.24em;text-transform:uppercase;font-size:.65rem}}h1{{font-family:serif;font-size:clamp(2.5rem,7vw,5rem);font-weight:400;line-height:1;margin:.8rem 0}}p{{color:var(--muted);max-width:760px;line-height:1.8}}.grid{{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:1.4rem;margin-top:2.5rem}}.card{{min-width:0}}.cover{{display:flex;aspect-ratio:2/3;background:#17130f;border:1px solid var(--border);align-items:center;justify-content:center;margin-bottom:.8rem}}img{{max-width:100%;max-height:100%;object-fit:contain}}strong{{display:block;font-family:serif;font-size:1.05rem;line-height:1.25}}small{{display:block;color:var(--muted);margin:.25rem 0 .4rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}.price{{color:var(--gold);font-weight:700}}.trust{{display:flex;gap:1rem;flex-wrap:wrap;margin-top:1.4rem;color:var(--gold);font-size:.8rem}}.cta{{margin-top:1.6rem;display:inline-block;border:1px solid var(--gold);padding:.8rem 1.2rem;color:var(--gold);font-size:.7rem;letter-spacing:.16em;text-transform:uppercase}}@media(max-width:900px){{.grid{{grid-template-columns:repeat(3,minmax(0,1fr))}}}}@media(max-width:560px){{nav{{align-items:flex-start;flex-direction:column}}.links{{font-size:.62rem}}.grid{{grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}}}}</style></head>
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
<link href="FONT_GOOGLE_URL_SIMPLE_PLACEHOLDER" rel="stylesheet"/>
<script>(function(){var d=document.documentElement;try{if(localStorage.getItem('iac_theme')!=='dark')d.setAttribute('data-theme','light')}catch(e){d.setAttribute('data-theme','light')}})()</script>
<style>
:root{--bg:#0d0b08;--bg2:#141210;--bg3:#1c1916;--gold:#c9a84c;--gold-dim:#7a6330;--cream:#f0e8d8;--cream-dim:#a09080;--white:#faf7f2;--border:rgba(201,168,76,0.18)}
html[data-theme="light"]{--bg:#faf7f2;--bg2:#f3ece0;--bg3:#ffffff;--gold:#7a5a12;--gold-dim:#6a4f10;--cream:#241c14;--cream-dim:#4e4032;--muted:#4e4032;--white:#0d0b08;--border:rgba(138,106,31,0.28)}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{max-width:100%;overflow-x:hidden;}
body{background:var(--bg);color:var(--cream);font-family:'Inter',sans-serif;font-weight:400;min-height:100vh}
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
.item-img{width:76px;flex-shrink:0;aspect-ratio:2/3;background:linear-gradient(145deg,rgba(255,255,255,.08),rgba(201,168,76,.07));overflow:hidden;border:1px solid var(--border);border-radius:14px;padding:5px;box-shadow:0 10px 26px rgba(0,0,0,.2);}
.item-img img{width:100%;height:100%;object-fit:contain;border-radius:9px;}
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
.coupon-box{border-top:1px solid var(--border);margin-top:1rem;padding:1rem .85rem .2rem;border-radius:14px;}
.coupon-box.sale-dress{background:linear-gradient(135deg,rgba(255,153,51,.11),rgba(255,255,255,.04) 48%,rgba(19,136,8,.11));box-shadow:inset 3px 0 #ff9933,inset -3px 0 #138808;}
.coupon-row{display:grid;grid-template-columns:1fr auto;gap:0.55rem;align-items:stretch;}
.coupon-select{width:100%;margin-bottom:0.55rem;background:var(--bg3);border:1px solid var(--border);color:var(--cream);padding:0.8rem 1rem;font-family:'Inter',sans-serif;font-size:0.72rem;letter-spacing:0.08em;outline:none;}
.coupon-input{font-size:0.72rem;text-transform:uppercase;letter-spacing:0.12em;}
.coupon-btn{font-family:'Inter',sans-serif;font-size:0.55rem;letter-spacing:0.16em;text-transform:uppercase;padding:0.75rem 0.9rem;background:var(--bg2);color:var(--gold);border:1px solid var(--border);cursor:pointer;font-weight:500;}
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
input,textarea,select{width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--cream);padding:0.8rem 1rem;font-family:'Inter',sans-serif;font-size:0.8rem;outline:none;transition:border-color 0.2s;}
input,textarea{-webkit-appearance:none;}
input:focus,textarea:focus,select:focus{border-color:rgba(201,168,76,0.5);}
input::placeholder,textarea::placeholder{color:rgba(160,144,128,0.5);}
input:disabled{background:var(--bg2);color:var(--gold-dim);cursor:not-allowed;}
/* The form reset above strips every input to appearance:none, width:100% and a
   999px radius. On a checkbox that removes the tick entirely -- the customer
   could opt in and see nothing change -- so the consent box opts back out of
   the reset and draws its own check. */
/* The theme sets border-radius and background with !important on every input,
   so the consent box has to match that weight or it stays a pill that looks
   the same ticked and unticked. */
#ch-wa-optin{-webkit-appearance:none;appearance:none;width:16px !important;height:16px !important;min-width:16px;flex:0 0 16px;padding:0 !important;border-radius:3px !important;border:1px solid var(--gold-dim) !important;background:var(--bg3) !important;box-shadow:none !important;position:relative;cursor:pointer;transition:background 0.15s,border-color 0.15s;}
#ch-wa-optin:checked{background:var(--gold) !important;border-color:var(--gold) !important;}
#ch-wa-optin:checked::after{content:'';position:absolute;left:5px;top:1px;width:4px;height:9px;border:solid var(--bg);border-width:0 2px 2px 0;transform:rotate(45deg);}
#ch-wa-optin:focus-visible{outline:2px solid var(--gold);outline-offset:2px;}
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
.pay-method-icon{width:38px;height:38px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:1.2rem;border-radius:6px;font-family:'Inter',sans-serif;}
.pay-method-body{flex:1;min-width:0;}
.pay-method-title{font-family:'Inter',sans-serif;font-size:0.78rem;color:var(--cream);font-weight:500;letter-spacing:0.04em;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;}
.pay-method-badge{font-size:0.5rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--gold);background:rgba(201,168,76,0.12);padding:0.2rem 0.5rem;border:1px solid rgba(201,168,76,0.3);font-weight:500;}
.pay-method-sub{font-size:0.62rem;color:var(--cream-dim);margin-top:0.2rem;letter-spacing:0.04em;}
@media(max-width:780px){.pay-method-icon{width:32px;height:32px;font-size:1rem;}.pay-method{padding:0.7rem 0.8rem;gap:0.7rem;}}

.btn-pay{width:100%;font-family:'Inter',sans-serif;font-size:0.65rem;letter-spacing:0.25em;text-transform:uppercase;padding:1.1rem;background:var(--gold);color:var(--bg);border:none;cursor:pointer;font-weight:500;transition:all 0.25s;margin-bottom:0.8rem;line-height:1.4;white-space:normal;overflow-wrap:anywhere;}
.btn-pay:hover{opacity:0.88;transform:translateY(-1px);}
.btn-pay:disabled{opacity:0.72;cursor:not-allowed;transform:none;}
.btn-cod{width:100%;font-family:'Inter',sans-serif;font-size:0.65rem;letter-spacing:0.2em;text-transform:uppercase;padding:1rem;background:transparent;color:var(--cream);border:1px solid rgba(201,168,76,0.35);cursor:pointer;font-weight:400;transition:all 0.25s;line-height:1.4;white-space:normal;overflow-wrap:anywhere;}
.btn-cod:hover{border-color:var(--gold);color:var(--gold);}
.btn-cod:disabled{opacity:0.72;cursor:not-allowed;}
.btn-partial{width:100%;font-family:'Inter',sans-serif;font-size:0.62rem;letter-spacing:0.16em;text-transform:uppercase;padding:1rem;background:rgba(201,168,76,0.1);color:var(--gold);border:1px solid rgba(201,168,76,0.35);cursor:pointer;font-weight:500;transition:all 0.25s;margin-bottom:0.8rem;line-height:1.5;white-space:normal;overflow-wrap:anywhere;}
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
/* Liquid pill checkout refresh */
:root{--pill:999px;--glass-bg:rgba(20,18,15,0.74);--glass-border:rgba(214,184,94,0.3);--glass-shadow:0 22px 70px rgba(0,0,0,0.42);--glass-highlight:inset 0 1px rgba(255,255,255,0.09);--warm-glow:rgba(201,168,76,0.16);--cool-glow:rgba(62,90,105,0.22)}
html[data-theme="light"]{--glass-bg:rgba(255,252,246,0.78);--glass-border:rgba(138,106,31,0.22);--glass-shadow:0 22px 70px rgba(77,56,25,0.12);--glass-highlight:inset 0 1px rgba(255,255,255,0.75);--warm-glow:rgba(201,168,76,0.12);--cool-glow:rgba(72,104,114,0.1)}
body{background:
  radial-gradient(circle at 12% 14%, var(--cool-glow), transparent 30rem),
  radial-gradient(circle at 82% 8%, rgba(124,54,64,0.18), transparent 28rem),
  radial-gradient(circle at 50% 86%, var(--warm-glow), transparent 34rem),
  linear-gradient(135deg, rgba(255,255,255,0.025), transparent 36%, rgba(201,168,76,0.04)),
  var(--bg);}
nav{width:min(980px,calc(100% - 24px));margin:0.75rem auto 0;padding:0.75rem 1.05rem;border:1px solid var(--glass-border);border-radius:var(--pill);background:var(--glass-bg);box-shadow:var(--glass-shadow),var(--glass-highlight);backdrop-filter:blur(18px) saturate(130%);-webkit-backdrop-filter:blur(18px) saturate(130%)}
.logo{display:inline-flex;align-items:center;gap:0.1rem;padding:0.35rem 0.7rem;border-radius:var(--pill);background:rgba(201,168,76,0.07)}
.nav-back,#chkAuthBtn,.theme-toggle{border-radius:var(--pill)!important}
main{max-width:980px}
.page-label{display:inline-flex;align-items:center;border-radius:var(--pill);padding:0.35rem 0.85rem;background:rgba(201,168,76,0.08);border:1px solid var(--glass-border)}
.form-section,.order-summary,#addrBook,#autofillBanner{border:1px solid var(--glass-border)!important;border-radius:30px!important;background:linear-gradient(145deg,rgba(255,255,255,0.055),rgba(255,255,255,0.015)),var(--glass-bg)!important;box-shadow:var(--glass-shadow),var(--glass-highlight);backdrop-filter:blur(16px) saturate(128%);-webkit-backdrop-filter:blur(16px) saturate(128%)}
.form-section{padding:1.15rem}
#autofillBanner{border-radius:var(--pill)!important}
.divider-label span,.summary-title{border-radius:var(--pill);background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.18);padding:0.42rem 0.9rem}
input,textarea,select,.coupon-select{border-radius:var(--pill)!important;background:rgba(255,255,255,0.045)!important;border-color:var(--glass-border)!important;box-shadow:inset 0 1px rgba(255,255,255,0.04)}
textarea{border-radius:24px!important}
.coupon-row{gap:0.65rem}
.coupon-btn,.btn-pay,.btn-cod,.btn-partial,.btn-home,.scratch-copy-btn,.checkout-remove,#addrBook button,#autofillBanner button{border-radius:var(--pill)!important}
.pay-method{border-radius:var(--pill)!important;background:rgba(255,255,255,0.045)!important;border-color:var(--glass-border)!important;box-shadow:inset 0 1px rgba(255,255,255,0.06)}
.pay-method.active{background:linear-gradient(135deg,rgba(201,168,76,0.18),rgba(201,168,76,0.045))!important;border-color:rgba(201,168,76,0.62)!important;box-shadow:0 14px 40px rgba(201,168,76,0.1),inset 0 1px rgba(255,255,255,0.08)}
.pay-method-icon{border-radius:16px!important}
.pay-method-badge{border-radius:var(--pill);padding:0.18rem 0.55rem}
.btn-pay{background:linear-gradient(135deg,#d7bc62,#9a7724)!important;box-shadow:0 16px 42px rgba(201,168,76,0.2);color:#090806!important}
.btn-pay:hover,.btn-partial:hover,.btn-cod:hover{transform:translateY(-1px)}
.btn-cod,.btn-partial{background:rgba(255,255,255,0.045)!important;border-color:var(--glass-border)!important}
.checkout-qty-btn{border-radius:50%!important}
.order-item{border-radius:22px;padding:0.75rem;background:rgba(255,255,255,0.025)}
.success-email-box{border-radius:24px}
.checkout-processing{position:fixed;inset:0;z-index:20000;display:none;align-items:center;justify-content:center;padding:1rem;background:rgba(4,3,2,0.68);backdrop-filter:blur(18px) saturate(130%);-webkit-backdrop-filter:blur(18px) saturate(130%)}
.checkout-processing.show{display:flex}
.checkout-processing-card{width:min(460px,calc(100vw - 28px));border:1px solid var(--glass-border);border-radius:34px;background:linear-gradient(145deg,rgba(255,255,255,0.08),rgba(255,255,255,0.025)),var(--glass-bg);box-shadow:0 28px 90px rgba(0,0,0,0.48),var(--glass-highlight);padding:2rem;text-align:center}
.checkout-loader{position:relative;width:84px;height:58px;margin:0 auto 1.1rem;perspective:260px}
.checkout-loader:before{content:'';position:absolute;inset:7px 8px 5px;border:1px solid rgba(201,168,76,0.45);border-radius:14px;background:linear-gradient(90deg,rgba(201,168,76,0.14),rgba(255,255,255,0.045));box-shadow:0 16px 38px rgba(0,0,0,0.22)}
.checkout-loader span{position:absolute;top:9px;left:42px;width:30px;height:42px;border-radius:5px 12px 12px 5px;background:linear-gradient(135deg,#f7efd8,#c9a84c);transform-origin:left center;animation:pageTurn 1.45s ease-in-out infinite;box-shadow:0 10px 26px rgba(201,168,76,0.2)}
.checkout-loader span:nth-child(2){animation-delay:0.18s;background:linear-gradient(135deg,#fff8e8,#d9c273)}
.checkout-loader span:nth-child(3){animation-delay:0.36s;background:linear-gradient(135deg,#fff,#b99436)}
@keyframes pageTurn{0%,100%{transform:rotateY(0deg)}45%,70%{transform:rotateY(-132deg)}}
.processing-kicker{font-size:0.62rem;letter-spacing:0.22em;text-transform:uppercase;color:var(--gold);margin-bottom:0.45rem}
.processing-title{font-family:'Cormorant Garamond',serif;font-size:2rem;color:var(--white);line-height:1.1;margin-bottom:0.8rem}
.processing-fact{font-size:0.76rem;color:var(--cream-dim);line-height:1.75;min-height:4.2rem;transition:opacity 0.22s ease}
.processing-pill{display:inline-flex;margin-top:0.9rem;padding:0.5rem 0.9rem;border-radius:var(--pill);border:1px solid rgba(201,168,76,0.22);color:var(--gold-dim);font-size:0.58rem;letter-spacing:0.12em;text-transform:uppercase}
/* Success screen */
#successScreen{display:none;text-align:center;padding:4rem 2rem;max-width:560px;margin:0 auto;}
.success-icon{font-size:3.5rem;margin-bottom:1.5rem;}
.success-title{font-family:'Cormorant Garamond',serif;font-size:2.6rem;font-weight:400;color:var(--white);margin-bottom:1rem;}
.success-sub{font-size:0.78rem;color:var(--cream-dim);line-height:1.9;margin-bottom:1.6rem;}
.success-id{font-size:0.62rem;color:var(--gold-dim);letter-spacing:0.12em;margin-bottom:1.5rem;}
.success-email-box{background:var(--bg3);border:1px solid var(--border);border-left:3px solid var(--gold);padding:1rem 1.4rem;text-align:left;margin-bottom:2rem;}
.btn-home{font-family:'Inter',sans-serif;font-size:0.62rem;letter-spacing:0.22em;text-transform:uppercase;padding:0.9rem 2.4rem;background:var(--gold);color:var(--bg);border:none;cursor:pointer;font-weight:500;text-decoration:none;display:inline-block;}
/* Scratch card */
.scratch-wrap{margin:2rem auto;max-width:340px;text-align:center;}
.scratch-title{font-family:'Cormorant Garamond',serif;font-size:1.4rem;color:var(--gold);margin-bottom:0.4rem;font-style:italic;}
.scratch-hint{font-size:0.66rem;color:var(--cream-dim);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:1rem;}
.scratch-card{position:relative;width:280px;height:280px;margin:0 auto;border-radius:14px;overflow:hidden;box-shadow:0 16px 40px rgba(138,106,31,0.28);user-select:none;}
.scratch-prize{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:linear-gradient(135deg,#1a1208 0%,#241b13 100%);color:var(--gold);text-align:center;padding:1.4rem;}
.scratch-prize-amt{font-family:'Cormorant Garamond',serif;font-size:3.4rem;font-weight:600;color:var(--gold);line-height:1;margin-bottom:0.5rem;text-shadow:0 0 30px rgba(201,168,76,0.5);}
.scratch-prize-label{font-size:0.7rem;color:#f0e8d8;letter-spacing:0.18em;text-transform:uppercase;margin-bottom:1rem;}
.scratch-prize-code{font-family:Menlo,Consolas,monospace;font-size:0.78rem;color:var(--gold);background:rgba(201,168,76,0.1);border:1px dashed rgba(201,168,76,0.5);padding:0.5rem 0.9rem;letter-spacing:0.12em;margin-bottom:0.6rem;}
.scratch-prize-exp{font-size:0.55rem;color:var(--gold-dim);letter-spacing:0.12em;text-transform:uppercase;}
.scratch-canvas{position:absolute;inset:0;cursor:grab;touch-action:none;display:block;}
.scratch-canvas:active{cursor:grabbing;}
.scratch-card.revealed .scratch-canvas{display:none;}
.scratch-copy-btn{margin-top:0.7rem;font-family:'Inter',sans-serif;font-size:0.6rem;letter-spacing:0.16em;text-transform:uppercase;padding:0.5rem 1.2rem;background:transparent;color:var(--gold);border:1px solid var(--gold);cursor:pointer;}
.scratch-copy-btn:hover{background:var(--gold);color:var(--bg);}
@keyframes confetti{0%{transform:translateY(0) rotate(0);opacity:1}100%{transform:translateY(420px) rotate(720deg);opacity:0}}
.confetti{position:absolute;width:8px;height:14px;pointer-events:none;animation:confetti 1.6s ease-out forwards;}
footer{text-align:center;padding:2rem;border-top:1px solid var(--border);font-size:0.65rem;color:var(--gold-dim);letter-spacing:0.08em;margin-top:auto;}
@media(max-width:700px){
  nav{position:static;padding:1rem 1.2rem;}
  main{padding:2rem 1rem 5rem;}
  h1{font-size:1.7rem;margin-bottom:1.4rem;}
  .checkout-grid{grid-template-columns:1fr;gap:1.5rem;}
  .order-summary{order:-1;position:static!important;top:auto!important;padding:1.2rem;max-width:100%;overflow:hidden;}
  .order-item{gap:.85rem;padding:.8rem .65rem;align-items:flex-start}
  .item-img{width:88px;padding:6px;border-radius:16px}
  .item-title{font-size:1.08rem;line-height:1.25;margin-top:.05rem}
  .item-author{font-size:.66rem;line-height:1.4}
  .item-qty-price{font-size:.74rem;line-height:1.45}
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
    <button id="chkAuthBtn" onclick="chkOpenAuth()"
      style="font-family:'Inter',sans-serif;font-size:0.6rem;letter-spacing:0.18em;text-transform:uppercase;
             padding:0.45rem 1rem;border:1px solid var(--border);color:var(--gold);background:transparent;
             cursor:pointer;transition:all 0.2s;">👤 Sign In</button>
    <button class="theme-toggle" onclick="(function(){var d=document.documentElement;var t=d.getAttribute('data-theme');if(t==='light'){d.removeAttribute('data-theme');try{localStorage.setItem('iac_theme','dark')}catch(e){}}else{d.setAttribute('data-theme','light');try{localStorage.setItem('iac_theme','light')}catch(e){}}})()" title="Toggle theme">☀</button>
  </div>
</nav>

<main>
  <!-- Success Screen (hidden until order placed) -->
  <div id="successScreen"></div>
  <div class="checkout-processing" id="checkoutProcessing" aria-live="polite" aria-hidden="true">
    <div class="checkout-processing-card" role="status">
      <div class="checkout-loader" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="processing-kicker" id="processingKicker">Preparing checkout</div>
      <div class="processing-title" id="processingTitle">Hold tight...</div>
      <div class="processing-fact" id="processingFact">A fresh book fact is loading while your order is being prepared.</div>
      <div class="processing-pill">Secure checkout in progress</div>
    </div>
  </div>

  <!-- Checkout Screen -->
  <div id="checkoutScreen">
    <div class="page-label">Secure Checkout</div>
    <h1>Delivery Details</h1>

    <!-- Autofill banner — shown when logged in with saved address -->
    <div id="autofillBanner" style="display:none;margin-bottom:1.4rem;padding:0.9rem 1.2rem;
         background:rgba(201,168,76,0.07);border:1px solid rgba(201,168,76,0.28);
         display:none;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;">
      <span style="font-size:0.72rem;color:var(--cream);">📍 <span id="autofillName"></span> — address filled from your saved profile</span>
      <button onclick="clearAutofill()" style="font-size:0.58rem;letter-spacing:0.12em;text-transform:uppercase;
              background:none;border:none;color:var(--cream-dim);cursor:pointer;text-decoration:underline;">Edit manually</button>
    </div>

    <!-- Address book picker — populated dynamically when user is signed in -->
    <div id="addrBook" style="display:none;margin-bottom:1.4rem;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.7rem;">
        <h3 style="font-family:'Cormorant Garamond',serif;font-size:1.1rem;color:var(--gold);font-weight:400;font-style:italic;">Choose a saved address</h3>
        <button type="button" onclick="addrShowNewForm()" style="font-size:0.6rem;letter-spacing:0.14em;text-transform:uppercase;background:transparent;border:1px solid var(--border);color:var(--cream-dim);padding:0.45rem 0.85rem;cursor:pointer;">+ Add new address</button>
      </div>
      <div id="addrBookList" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:0.7rem;"></div>
    </div>

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
            <input id="ch-phone" type="tel" placeholder="10-digit mobile" autocomplete="tel" inputmode="tel" oninput="sanitizePhoneField(this)"/>
          </div>
        </div>

        <div class="form-group">
          <label for="ch-email">Email Address <span style="color:var(--gold);">*</span></label>
          <input id="ch-email" type="email" placeholder="you@example.com" autocomplete="email" inputmode="email" required/>
        </div>

        <div class="form-group">
          <label for="ch-addr">House / Street / Locality *</label>
          <textarea id="ch-addr" rows="2" placeholder="e.g. 12B, MG Road, Lajpat Nagar" autocomplete="street-address" style="resize:vertical;min-height:54px;font-family:inherit"></textarea>
        </div>

        <div class="pincode-row">
          <div>
            <label for="ch-pin">Pincode *</label>
            <input id="ch-pin" type="text" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" placeholder="6 digits"
              oninput="handlePin(this.value)"/>
          </div>
          <div class="ch-city-col">
            <label for="ch-city">City</label>
            <input id="ch-city" type="text" placeholder="Auto-filled"/>
          </div>
          <div class="ch-state-col">
            <label for="ch-state">State</label>
            <input id="ch-state" type="text" placeholder="Auto-filled"/>
          </div>
        </div>
        <div id="pinMsg" class="pin-msg"></div>
        <div id="shippingRestrictionMsg" style="display:none;margin:.65rem 0 1rem;padding:.85rem 1rem;border:1px solid rgba(224,80,80,.55);border-radius:14px;background:rgba(224,80,80,.09);color:#f09a8c;font-size:.7rem;line-height:1.6;"></div>

        <div id="paymentBlock">
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
        <div style="display:flex;align-items:center;gap:0.45rem;margin-top:0.35rem;font-size:0.7rem;color:#a09080;letter-spacing:0.04em;">
          <span style="font-size:0.85rem;">☁️</span>
          <span>Refunds Powered By <strong style="color:#f0e8d8;">Amazon Web Services (AWS)</strong></span>
        </div>
        <button class="btn-partial" id="btnPartial" onclick="submitOrder('partial')">
          Pay 10% Now · 90% on Delivery
        </button>
        <div class="partial-note" id="partialNote">Available on orders of ₹299 and above. COD fee waived.</div>
        <button class="btn-cod" id="btnCOD" onclick="submitOrder('cod')">
          🚚 Cash on Delivery
        </button>
        <div class="cod-note" id="codNote" style="font-size:0.66rem;color:var(--cream-dim);line-height:1.6;margin-top:0.5rem;text-align:center;padding:0 0.2rem;"></div>

        <!-- Marketing consent. Deliberately UNCHECKED: a pre-ticked box is not
             consent, and sending marketing to people who never agreed is what
             gets a WhatsApp number's quality rating cut -- which would damage
             the order and shipping messages we depend on. -->
        <label for="ch-wa-optin" style="display:flex;gap:0.55rem;align-items:flex-start;margin-top:0.85rem;padding:0.6rem 0.7rem;border:1px solid var(--border);border-radius:6px;cursor:pointer;text-align:left;">
          <input id="ch-wa-optin" type="checkbox" style="margin-top:0.1rem;flex:0 0 auto;width:15px;height:15px;border-radius:3px;accent-color:var(--gold);cursor:pointer;"/>
          <span style="font-size:0.7rem;color:var(--cream-dim);line-height:1.5;text-transform:none;letter-spacing:normal;font-weight:400;">
            Send me book recommendations and offers on WhatsApp. Order and delivery updates are sent either way. Reply <strong>STOP</strong> any time to opt out.
          </span>
        </label>
        </div><!-- /paymentBlock -->

        <div class="trust-row">
          <span>🔒 Secure checkout</span>
          <span>🚀 Pan-India delivery</span>
          <span>↩ 7-day returns</span>
        </div>

        <!-- Meta Verified proof — real screenshot of our verified Instagram, links out -->
        <a href="https://www.instagram.com/inkandchai.in/" target="_blank" rel="noopener" title="Ink &amp; Chai on Instagram — Meta Verified Business" style="display:block;margin:0.9rem auto 0;max-width:340px;border:1px solid var(--border);border-radius:8px;overflow:hidden;text-decoration:none;background:#fff">
          <img src="/images/meta-verified-inkandchai.webp" alt="Ink &amp; Chai is a Meta Verified Business on Instagram — 28.8K followers" width="760" height="368" loading="lazy" style="display:block;width:100%;height:auto"/>
          <span style="display:flex;align-items:center;gap:0.4rem;padding:0.5rem 0.75rem;font-size:0.68rem;font-weight:600;letter-spacing:0.02em;color:#fff;background:#1877F2">
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="#fff" d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.68.88-3.34 2.19c-1.39-.46-2.9-.2-3.91.81s-1.26 2.52-.81 3.91c-1.31.67-2.19 1.91-2.19 3.34s.88 2.67 2.19 3.34c-.45 1.39-.2 2.9.81 3.91s2.52 1.26 3.91.81c.66 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34z"/><path fill="#1877F2" d="M10.09 15.42l-3.8-3.79 1.41-1.42 2.39 2.38 5.62-5.62 1.41 1.42z"/></svg>
            Meta Verified Business →
          </span>
        </a>
      </div>

      <!-- RIGHT: Order Summary -->
      <div class="order-summary">
        <div class="summary-title">Your Order</div>
        <div id="orderItems">
          <div class="empty-cart">Your cart is empty.<br/>
            <a href="/" style="color:var(--gold);">Browse books →</a>
          </div>
        </div>
        <div class="coupon-box<!--SALE:START--> sale-dress<!--SALE:END-->" id="couponBox" style="display:none;">
          <label for="couponSelect">Available Coupons</label>
          <select class="coupon-select" id="couponSelect" onchange="handleCouponSelect(this.value)">
<!--SALE:START-->            <option value="FREEDOM">🇮🇳 FREEDOM · 15% auto-applied above ₹399</option>
<!--SALE:END-->            <option value="">Choose another prepaid offer</option>
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
<script src="/js/google-customer-reviews.js"></script>
<!-- Google automated discounts. Must load HERE too, not only on product pages:
     every checkout request reads window.iacDiscountGrants() to replay the grant
     the server re-verifies before pricing. Without it the grants array is always
     empty and a Google-discounted price silently reverts to full price. -->
<script src="/js/google-discount.js"></script>

<script>
// ── Cart (must match cart.js CART_KEY) ────────────────────────────────────
const CART_KEY = 'akshar_cart';
const KW_CART_KEY = 'kw_cart';
const BUY_NOW_KEY = 'iac_buy_now_cart';
const CHECKOUT_CART_KEY = 'iac_checkout_cart_key';
const IS_KAWAII = new URLSearchParams(location.search).get('kawaii') === '1';
const IS_BUY_NOW = new URLSearchParams(location.search).get('buynow') === '1';
const IS_PAYMENT_RETURN = new URLSearchParams(location.search).has('paid') || new URLSearchParams(location.search).has('failed');
// Buy Now is a one-shot: only honour the buy-now cart when the URL explicitly says
// so (?buynow=1). Otherwise a leftover iac_buy_now_cart from an earlier abandoned
// "Buy Now" must NOT hijack a normal cart checkout (it can even be empty) — clear it.
function cartHasItems(key) {
  try {
    const cart = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(cart) && cart.length > 0;
  } catch {
    return false;
  }
}
function rememberedCartKey() {
  const remembered = localStorage.getItem(CHECKOUT_CART_KEY);
  const allowed = [BUY_NOW_KEY, KW_CART_KEY, CART_KEY];
  return allowed.includes(remembered) && cartHasItems(remembered) ? remembered : '';
}
function activeCartKey() {
  if (IS_PAYMENT_RETURN) {
    const remembered = rememberedCartKey();
    if (remembered) return remembered;
    if (cartHasItems(BUY_NOW_KEY)) return BUY_NOW_KEY;
  }
  if (IS_BUY_NOW) {
    if (cartHasItems(BUY_NOW_KEY)) return BUY_NOW_KEY;
    localStorage.removeItem(BUY_NOW_KEY);
  } else if (!IS_PAYMENT_RETURN) {
    localStorage.removeItem(BUY_NOW_KEY);
  }
  if (IS_KAWAII) return KW_CART_KEY;
  return CART_KEY;
}
function getCart()  { try { return JSON.parse(localStorage.getItem(activeCartKey()) || '[]'); } catch { return []; } }
function clearCart(){
  localStorage.removeItem(activeCartKey());
  // Also clear any applied coupon / scratch card so it doesn't auto-apply on the next order
  localStorage.removeItem('iac_checkout_coupon');
  localStorage.removeItem('iac_scratch_card');
  localStorage.removeItem(CHECKOUT_CART_KEY);
}
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
const COD_HANDLING_FEE = 20;  // extra ₹20 charged on COD orders to cover RTO risk + courier surcharge
const COD_FEE_WAIVER_THRESHOLD = 999;  // fee is WAIVED on COD orders at or above this subtotal — pushes AOV up
// Minimum item value for Cash on Delivery. A sub-₹199 COD parcel cannot carry
// its own cost once the ₹40 freight and the RTO risk are counted — and COD is
// the rail that fails, so the smallest baskets are the least worth shipping on
// it. Below this the button is disabled and the shortfall is quoted, which
// nudges the basket up instead of simply refusing. MUST stay in step with
// COD_MIN_SUBTOTAL in netlify/functions/cod-order.js, which enforces it.
const COD_MIN_SUBTOTAL = 199;
const COUPON_KEY = 'iac_checkout_coupon';
const COUPONS = {
  FREEDOM:   { type: 'percent', value: 15, minSubtotal: 400, onlineOnly: false, label: '🇮🇳 Freedom Sale 15% off', expiresAt: '2026-08-15T18:29:59Z' },
  SUMMER10:  { type: 'percent', value: 10, minSubtotal: 299, onlineOnly: false, label: '☀️ Summer Sale 10% off', expiresAt: '2026-05-19T18:30:00Z' },
  INKLOVE10: { type: 'percent', value: 10, minSubtotal: 499, onlineOnly: true, label: '10% prepaid discount' },
  '499HIT':  { type: 'percent', value: 10, minSubtotal: 499, onlineOnly: true, label: '10% prepaid discount' },
  SAVE12:    { type: 'percent', value: 12, minSubtotal: 999, onlineOnly: true, label: '12% prepaid discount' },
  SAVE15:    { type: 'percent', value: 15, minSubtotal: 1499, onlineOnly: true, label: '15% prepaid discount' },
  CHAI10BACK:{ type: 'percent', value: 10, minSubtotal: 299, onlineOnly: true, label: 'Private 10% recovery discount' },
};
const PARTIAL_PAYMENT_THRESHOLD = 299;
const PARTIAL_PAYMENT_RATE = 0.10;
let appliedCouponCode = (localStorage.getItem(COUPON_KEY) || '').toUpperCase();
const SCRATCH_KEY = 'iac_scratch_card';
function loadScratchState() {
  try { return JSON.parse(localStorage.getItem(SCRATCH_KEY) || 'null'); } catch { return null; }
}
let appliedScratchCard = loadScratchState(); // {code, value_paise, min_subtotal_paise, expires_at} or null
function calcShipping(subtotal) { return subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE; }
function itemQty(item) { return Math.max(1, Number(item?.qty) || 1); }
function itemPrice(item) { return Number(item?.price) || 0; }
function cartSubtotal(cart) { return cart.reduce((s, i) => s + itemPrice(i) * itemQty(i), 0); }
function couponItemSlug(item) {
  if (item?.slug) return String(item.slug);
  const raw = String(item?.url || item?.id || '');
  const match = raw.match(/\/product\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : raw.replace(/^\/+|\/+$/g, '');
}
function couponEligibleSubtotal(cart, productSlugs) {
  const allowed = new Set(productSlugs || []);
  return cart.reduce((sum, item) => allowed.has(couponItemSlug(item))
    ? sum + itemPrice(item) * itemQty(item) : sum, 0);
}
function saveCart(cart) { localStorage.setItem(activeCartKey(), JSON.stringify(cart)); }
function normalizeCouponCode(value) {
  const s = String(value || '').toUpperCase().trim();
  // Preserve hyphen ONLY for SCRATCH-XXX codes (otherwise strip non-alphanumeric like before)
  if (s.startsWith('SCRATCH-')) return s.replace(/[^A-Z0-9-]/g, '');
  return s.replace(/[^A-Z0-9]/g, '');
}
function freedomIsLive() {
  return Date.now() <= new Date(COUPONS.FREEDOM.expiresAt).getTime();
}

/** The hint under the coupon box, which must not promise an ended sale. */
function defaultCouponHint() {
  return freedomIsLive()
    ? '🇮🇳 Add books until the subtotal is above ₹399 and FREEDOM will apply 15% off automatically.'
    : 'Prepaid orders unlock the offers above. Pick one, or enter a private code.';
}

/**
 * Take the ended sale off a checkout that was built while it was still running.
 *
 * The build strips these too, but a page cached before the deadline keeps
 * offering FREEDOM in the dropdown and wearing the tricolour, while
 * couponDiscount() correctly refuses to apply it — the customer is shown a
 * discount the till will not honour. That exact mismatch ran on the homepage
 * for a fortnight, so checkout gets the same second line of defence.
 */
function removeExpiredSaleFromCheckout() {
  if (freedomIsLive()) return;
  document.querySelector('#couponSelect option[value="FREEDOM"]')?.remove();
  document.getElementById('couponBox')?.classList.remove('sale-dress');
}

function couponDiscount(cart, method = 'online') {
  const subtotal = cartSubtotal(cart);
  const code = normalizeCouponCode(appliedCouponCode);

  // Independence Day sale is automatic for every payment mode and never
  // stacks with another code. “Above ₹399” means ₹400 or more.
  const freedom = COUPONS.FREEDOM;
  if (Date.now() <= new Date(freedom.expiresAt).getTime() && subtotal > 399) {
    const discount = Math.floor(subtotal * freedom.value / 100);
    return { code: 'FREEDOM', discount, message: '🇮🇳 FREEDOM automatically applied — 15% off your books.' };
  }

  // ── Scratch card path ───────────────────────────────────────────────────
  if (code.startsWith('SCRATCH-') && appliedScratchCard && appliedScratchCard.code === code) {
    const card = appliedScratchCard;
    if (card.expires_at && Date.now() > new Date(card.expires_at).getTime()) {
      return { code, discount: 0, message: `${code} has expired.` };
    }
    const minSub = (card.min_subtotal_paise || 0) / 100;
    if (subtotal < minSub) {
      return { code, discount: 0, message: `Add ₹${(minSub - subtotal).toLocaleString('en-IN')} more to use this scratch card.` };
    }
    const discount = Math.round((card.value_paise || 0) / 100);
    return { code, discount, message: `🎁 Scratch card ₹${discount} cashback applied.` };
  }

  // ── Static coupon path ─────────────────────────────────────────────────
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
  const discountBase = coupon.productSlugs
    ? couponEligibleSubtotal(cart, coupon.productSlugs)
    : subtotal;
  if (coupon.productSlugs && discountBase <= 0) {
    return { code, discount: 0, message: `${code} is only valid for selected products.` };
  }
  if (discountBase < coupon.minSubtotal) {
    return { code, discount: 0, message: `Add ₹${(coupon.minSubtotal - discountBase).toLocaleString('en-IN')} more in eligible products to use ${code}.` };
  }
  const discount = coupon.type === 'percent' ? Math.floor(discountBase * coupon.value / 100) : Math.min(Math.floor(discountBase), Math.floor(coupon.value));
  return { code, discount: Math.max(0, discount), message: `${coupon.label} applied.` };
}
function orderTotals(cart, method = 'online') {
  const subtotal = cartSubtotal(cart);
  const shipping = calcShipping(subtotal);
  const coupon = couponDiscount(cart, method);
  // COD fee waived on subtotal >= ₹999 (pushes customers to add more to cart)
  const codFee  = (method === 'cod' && subtotal < COD_FEE_WAIVER_THRESHOLD) ? COD_HANDLING_FEE : 0;
  const grand   = Math.max(1, subtotal + shipping + codFee - coupon.discount);
  return { subtotal, shipping, codFee, discount: coupon.discount, couponCode: coupon.code, couponMessage: coupon.message, total: grand };
}
function partialPaymentTotals(cart) {
  // Partial COD: COD handling fee is WAIVED as the incentive to pre-pay 10%.
  // FREEDOM is the one coupon valid on partial COD as well as every other mode.
  const subtotal = cartSubtotal(cart);
  const shipping = calcShipping(subtotal);
  const coupon = couponDiscount(cart, 'cod');
  const discount = coupon.code === 'FREEDOM' ? coupon.discount : 0;
  const total = Math.max(1, subtotal + shipping - discount);
  const eligible = total >= PARTIAL_PAYMENT_THRESHOLD;
  const deposit = eligible ? Math.max(1, Math.ceil(total * PARTIAL_PAYMENT_RATE)) : 0;
  return { subtotal, shipping, codFee: 0, discount, couponCode: discount ? 'FREEDOM' : '', couponMessage: discount ? coupon.message : '', total, eligible, deposit, balance: Math.max(0, total - deposit), rate: PARTIAL_PAYMENT_RATE };
}
// True when the cart contains any item flagged _no_cod — the full crossword.in
// catalogue import (tag 'no-cod'). Those titles disable Cash on Delivery and
// steer the customer to Partial COD (pay 10%) or full prepaid instead. The flag
// is stamped onto the cart item at add-to-cart time (product-page.js / catalog).
function cartHasNoCod(cart) {
  return Array.isArray(cart) && cart.some(i => i && i._no_cod === true);
}
// How far this cart is from qualifying for COD, in rupees. 0 means it qualifies.
// THREE places decide whether the COD button is live — this renderer, the
// shipping-restriction recheck, and setLoading — and each recomputes the flag
// from scratch. They must all consult this, or a pincode check or a finished
// spinner silently re-enables a button the minimum had disabled.
function codShortfall(cart) {
  return Math.max(0, COD_MIN_SUBTOTAL - cartSubtotal(cart || getCart()));
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

async function applyCoupon() {
  const input = document.getElementById('couponCode');
  const select = document.getElementById('couponSelect');
  const msg = document.getElementById('couponMsg');
  const code = normalizeCouponCode(input?.value);
  if (!code) {
    appliedCouponCode = '';
    appliedScratchCard = null;
    localStorage.removeItem(COUPON_KEY);
    localStorage.removeItem(SCRATCH_KEY);
    if (select) select.value = '';
    if (msg) {
      msg.textContent = 'Coupon removed.';
      msg.style.color = 'var(--cream-dim)';
    }
    renderSummary();
    return;
  }
  // ── Scratch card flow — validate server-side ────────────────────────────
  if (code.startsWith('SCRATCH-')) {
    if (msg) { msg.textContent = 'Checking scratch card…'; msg.style.color = 'var(--cream-dim)'; }
    try {
      const cart = getCart();
      const subPaise = Math.round(cartSubtotal(cart) * 100);
      const r = await fetch('/.netlify/functions/scratch-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'validate', code, subtotal_paise: subPaise }),
      });
      const j = await r.json();
      if (!j.valid) {
        const reasonText = {
          not_found: 'This scratch card code does not exist.',
          already_used: 'This scratch card has already been used.',
          not_scratched: 'Please scratch the card first.',
          expired: 'This scratch card has expired.',
          min_subtotal: `Add ₹${Math.max(0, ((j.min_subtotal_paise||0)/100 - cartSubtotal(cart))).toLocaleString('en-IN')} more to use this card.`,
        }[j.reason] || 'Scratch card not valid.';
        if (msg) { msg.textContent = reasonText; msg.style.color = '#c97a7a'; }
        return;
      }
      appliedCouponCode = code;
      appliedScratchCard = {
        code: j.code,
        value_paise: j.discount_paise,
        min_subtotal_paise: j.min_subtotal_paise,
        expires_at: j.expires_at || null,
      };
      localStorage.setItem(COUPON_KEY, code);
      localStorage.setItem(SCRATCH_KEY, JSON.stringify(appliedScratchCard));
      renderSummary();
    } catch (e) {
      if (msg) { msg.textContent = 'Could not validate code right now.'; msg.style.color = '#c97a7a'; }
    }
    return;
  }
  // Product-specific codes are fetched on demand as well as shown in the
  // dropdown. Payment functions independently verify the product and price.
  if (!COUPONS[code]) {
    if (msg) { msg.textContent = 'Checking coupon…'; msg.style.color = 'var(--cream-dim)'; }
    await loadManagedPromotionCode(code);
    if (!COUPONS[code]) await loadProductCoupons(getCart(), code);
    if (!COUPONS[code]) {
      if (msg) { msg.textContent = 'This coupon code is not valid for the products in your cart.'; msg.style.color = '#c97a7a'; }
      return;
    }
  }
  appliedCouponCode = code;
  appliedScratchCard = null;
  localStorage.setItem(COUPON_KEY, code);
  localStorage.removeItem(SCRATCH_KEY);
  if (select) {
    const hasVisibleOption = Array.from(select.options).some(option => option.value === code);
    select.value = hasVisibleOption ? code : '';
  }
  renderSummary();
}

let loadedProductCouponCartKey = '';
async function loadProductCoupons(cart, requestedCode = '') {
  const slugs = [...new Set(cart.map(couponItemSlug).filter(Boolean))];
  if (!slugs.length) return;
  const key = slugs.slice().sort().join(',');
  if (!requestedCode && key === loadedProductCouponCartKey) return;
  try {
    const res = await fetch(`/.netlify/functions/product-coupons?slugs=${encodeURIComponent(slugs.join(','))}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return;
    const select = document.getElementById('couponSelect');
    if (select) select.querySelectorAll('[data-product-coupon]').forEach(option => option.remove());
    (data.coupons || []).forEach(rule => {
      COUPONS[rule.code] = {
        type: rule.discount_type,
        value: Number(rule.discount_value) || 0,
        minSubtotal: Number(rule.min_subtotal_inr) || 0,
        onlineOnly: rule.online_only !== false,
        label: rule.label,
        expiresAt: rule.expires_at,
        productSlugs: rule.product_slugs || [],
      };
      if (select) {
        const option = document.createElement('option');
        option.value = rule.code;
        option.dataset.productCoupon = '1';
        const offer = rule.discount_type === 'percent' ? `${Number(rule.discount_value)}% off` : `₹${Number(rule.discount_value)} off`;
        option.textContent = `${rule.code} · ${offer} · ${rule.label}`;
        select.appendChild(option);
      }
    });
    loadedProductCouponCartKey = key;
  } catch (err) {
    console.warn('Product coupons unavailable:', err.message);
  }
}

// ── Managed promotions (admin Promotions tab) ───────────────────────────────
// These live in R2 and are edited from the admin panel. Until this loader
// existed the checkout only knew the hardcoded COUPONS table above, so a rate
// changed in the panel never reached a customer. Managed rules are applied on
// top of the defaults, which makes the panel the source of truth for any code
// it defines; codes it does not define keep their hardcoded behaviour.
let MANAGED_PROMOTIONS = [];

function registerManagedPromotion(p) {
  COUPONS[p.code] = {
    type: p.discount_type,
    value: Number(p.discount_value) || 0,
    minSubtotal: Number(p.min_subtotal_inr) || 0,
    maxDiscount: Number(p.max_discount_inr) || 0,
    label: p.name,
    productSlugs: p.scope === 'selected' ? (p.product_slugs || []) : null,
    paymentMethods: p.payment_methods || ['prepaid'],
    onlineOnly: false,
    expiresAt: p.ends_at || null,
  };
}

async function loadManagedPromotions() {
  try {
    const res = await fetch('/.netlify/functions/promotions', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return;
    MANAGED_PROMOTIONS = data.promotions || [];
    const select = document.getElementById('couponSelect');
    if (select) select.querySelectorAll('[data-managed-promo]').forEach(o => o.remove());
    MANAGED_PROMOTIONS.filter(p => p.is_live).forEach(p => {
      registerManagedPromotion(p);
      // The static markup lists the default rates. Once the panel overrides a
      // code, its hardcoded option would advertise the OLD rate next to the new
      // one — two INKLOVE10 rows, "10% off" and "7% off", both applying 7%.
      if (select) {
        select.querySelectorAll(`option[value="${p.code}"]:not([data-managed-promo])`)
          .forEach(o => o.remove());
      }
      if (!p.auto_apply && select) {
        const o = document.createElement('option');
        o.value = p.code;
        o.dataset.managedPromo = '1';
        const offer = p.discount_type === 'percent' ? `${p.discount_value}% off` : `₹${p.discount_value} off`;
        o.textContent = `${p.code} · ${offer} · ${p.name}`;
        select.appendChild(o);
      }
    });
  } catch (err) {
    console.warn('Managed promotions unavailable:', err.message);
  }
}

// A private/unlisted code is not in the public list, so look it up by code.
async function loadManagedPromotionCode(code) {
  try {
    const res = await fetch('/.netlify/functions/promotions?code=' + encodeURIComponent(code), { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return;
    (data.promotions || []).filter(p => p.is_live).forEach(registerManagedPromotion);
  } catch (err) {
    console.warn('Managed promotion lookup failed:', err.message);
  }
}

// ── Render order summary ────────────────────────────────────────────────────
// InitiateCheckout, once per page load with a non-empty cart. renderSummary()
// re-runs on every quantity change and coupon entry, so it is guarded — without
// that, editing a basket would report a dozen checkout starts for one shopper.
let _iacCheckoutReported = false;
function reportInitiateCheckout(cart, total) {
  if (_iacCheckoutReported || !cart.length || typeof window.iacMeta !== 'function') return;
  _iacCheckoutReported = true;
  window.iacMeta('InitiateCheckout', {
    currency: 'INR',
    value: Number(total) || 0,
    content_ids: window.iacMetaIds(cart),
    content_type: 'product',
    num_items: cart.reduce((s, i) => s + (Number(i.qty) || 1), 0),
  });
}

function renderSummary() {
  // Cheap and idempotent, and renderSummary is the one function that always
  // runs before the coupon box is shown.
  removeExpiredSaleFromCheckout();
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
    // Hide the whole payment block so an empty cart never shows a payable amount.
    const _pb = document.getElementById('paymentBlock');
    if (_pb) _pb.style.display = 'none';
    if (btnPay) btnPay.disabled = true;
    if (btnPartial) btnPartial.disabled = true;
    if (partialNote) partialNote.textContent = 'Available on orders of ₹299 and above. COD fee waived.';
    if (btnCOD) btnCOD.disabled = true;
    return;
  }

  const _pb = document.getElementById('paymentBlock');
  if (_pb) _pb.style.display = '';
  const { subtotal, shipping, discount, couponCode, couponMessage, total: grand } = orderTotals(cart, 'online');
  if (couponBox) couponBox.style.display = 'block';
  const displayedCouponCode = couponCode || appliedCouponCode;
  if (couponInput && couponInput.value !== displayedCouponCode) couponInput.value = displayedCouponCode;
  if (couponSelect) {
    const hasVisibleOption = Array.from(couponSelect.options).some(option => option.value === displayedCouponCode);
    couponSelect.value = hasVisibleOption ? displayedCouponCode : '';
  }
  if (couponMsg) {
    couponMsg.textContent = couponMessage || defaultCouponHint();
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
  // Reported here rather than on page load: `grand` is the real payable total,
  // after shipping and any auto-applied coupon.
  reportInitiateCheckout(cart, grand);

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
      partialNote.innerHTML = partial.eligible
        ? `Pay ₹${partial.deposit.toLocaleString('en-IN')} now, ₹${partial.balance.toLocaleString('en-IN')} on delivery. <strong style="color:#5d9b55;">₹${COD_HANDLING_FEE} COD fee waived</strong> when you pay partially.`
        : `Available on orders of ₹299 and above. COD fee waived. Add ₹${(PARTIAL_PAYMENT_THRESHOLD - partial.total).toLocaleString('en-IN')} more to enable.`;
    }
  }
  const noCod = cartHasNoCod(cart);
  if (btnCOD) {
    const codTotals = orderTotals(cart, 'cod');
    const codNote = document.getElementById('codNote');
    const codShort = codShortfall(cart);
    if (codShort > 0) {
      // Below the COD minimum. Quote the exact shortfall rather than just
      // refusing — the customer is one small book away from qualifying.
      btnCOD.textContent = `🚫 Cash on Delivery — add ₹${codShort.toLocaleString('en-IN')} more`;
      btnCOD.disabled = true;
      btnCOD.style.opacity = '0.5';
      btnCOD.style.cursor = 'not-allowed';
      if (codNote) {
        codNote.innerHTML = `Add more items of <strong style="color:var(--gold);">₹${codShort.toLocaleString('en-IN')}</strong> to avail Cash on Delivery `
          + `(minimum ₹${COD_MIN_SUBTOTAL} order value). Or choose <strong>Pay Now</strong> above — no minimum, no COD fee, `
          + `and it earns a cashback scratch card (up to ₹200).`;
      }
    } else if (noCod) {
      // Full crossword.in catalogue titles: COD disabled, partial COD pushed.
      btnCOD.textContent = '🚫 Cash on Delivery unavailable';
      btnCOD.disabled = true;
      btnCOD.style.opacity = '0.5';
      btnCOD.style.cursor = 'not-allowed';
      if (codNote) {
        codNote.innerHTML = `Cash on Delivery isn't available for one or more titles in your cart. <strong style="color:var(--gold);">We recommend Pay 10% Now</strong> above — confirm your order with a small deposit and pay the rest on delivery. Full prepaid also works.`;
      }
    } else {
    btnCOD.textContent = `🚚 Cash on Delivery — ₹${codTotals.total.toLocaleString('en-IN')}`;
    btnCOD.disabled = false;
    btnCOD.style.opacity = '';
    btnCOD.style.cursor = '';
    // Dynamic note: explain fee OR celebrate that it's been waived
    if (codNote) {
      const sub = cartSubtotal(cart);
      if (codTotals.codFee > 0) {
        const needed = COD_FEE_WAIVER_THRESHOLD - sub;
        codNote.innerHTML = `Includes <strong style="color:var(--gold);">₹${codTotals.codFee} COD handling fee</strong>. Add <strong>₹${needed.toLocaleString('en-IN')}</strong> more to waive it, or pick <strong>Pay 10% Now</strong> above — <strong style="color:#5d9b55;">COD fee waived on partial</strong>. Pay Now skips the fee AND earns a cashback scratch card (up to ₹200).`;
      } else {
        codNote.innerHTML = `🎉 <strong style="color:#5d9b55;">₹${COD_HANDLING_FEE} COD fee waived</strong> on orders above ₹${COD_FEE_WAIVER_THRESHOLD.toLocaleString('en-IN')}. Choose <strong>Pay Now</strong> to also earn a cashback scratch card (up to ₹200).`;
      }
    }
    }
  }
  applyShippingRestrictionUi();
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Abandoned checkout capture ─────────────────────────────────────────────
let _abandonedTimer = null;
function collectPartialAddr() {
  const get = id => document.getElementById(id)?.value.trim() || '';
  // Match collectAddr — textarea -> single-line normalisation so abandoned-cart
  // recovery emails see the same address shape as the eventual order.
  const addr = get('ch-addr').replace(/\\s*\\n+\\s*/g, ', ').replace(/\\s{2,}/g, ' ').replace(/(,\\s*){2,}/g, ', ').replace(/^,\\s*|,\\s*$/g, '').trim();
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
let _shippingRestrictionBlocked = false;
let _shippingRestrictionText = '';
let _shippingRestrictionSeq = 0;

function applyShippingRestrictionUi() {
  const blocked = _shippingRestrictionBlocked;
  const notice = document.getElementById('shippingRestrictionMsg');
  if (notice) {
    notice.style.display = blocked ? '' : 'none';
    notice.textContent = blocked ? `🚫 ${_shippingRestrictionText}` : '';
  }
  const pay = document.getElementById('btnPayNow');
  const partial = document.getElementById('btnPartial');
  const cod = document.getElementById('btnCOD');
  if (pay) pay.disabled = blocked || !!_loadingMethod;
  if (partial) partial.disabled = blocked || !!_loadingMethod || !partialPaymentTotals(getCart()).eligible;
  if (cod) cod.disabled = blocked || !!_loadingMethod || cartHasNoCod(getCart()) || codShortfall() > 0;
  [pay, partial, cod].filter(Boolean).forEach(button => {
    button.style.opacity = blocked ? '0.45' : '';
    button.style.cursor = blocked ? 'not-allowed' : '';
    button.title = blocked ? _shippingRestrictionText : '';
  });
}

async function checkProductShippingForPin(pin) {
  const seq = ++_shippingRestrictionSeq;
  if (String(pin || '').length !== 6 || !getCart().length) {
    _shippingRestrictionBlocked = false;
    _shippingRestrictionText = '';
    applyShippingRestrictionUi();
    return;
  }
  try {
    const res = await fetch('/.netlify/functions/check-product-shipping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cart: getCart(),
        pincode: pin,
        state: document.getElementById('ch-state')?.value || '',
        address: document.getElementById('ch-addr')?.value || '',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (seq !== _shippingRestrictionSeq || !res.ok) return;
    _shippingRestrictionBlocked = data.allowed === false;
    _shippingRestrictionText = data.error || '';
    applyShippingRestrictionUi();
  } catch (_) {
    // The final order endpoint still enforces the same rule server-side.
  }
}

function clearShippingRestrictionUi() {
  _shippingRestrictionSeq++;
  _shippingRestrictionBlocked = false;
  _shippingRestrictionText = '';
  applyShippingRestrictionUi();
}

function handlePin(val) {
  const msg = document.getElementById('pinMsg');
  const cityCol  = document.querySelector('.ch-city-col');
  const stateCol = document.querySelector('.ch-state-col');
  clearTimeout(_pinTimer);
  val = val.replace(/\\D/g,'');
  clearShippingRestrictionUi();
  if (val.length < 6) {
    msg.textContent = ''; msg.style.color = '';
    // Show city/state inputs again so manual edit works while typing.
    if (cityCol)  cityCol.style.display  = '';
    if (stateCol) stateCol.style.display = '';
    return;
  }
  msg.textContent = 'Looking up pincode…';
  msg.style.color = '#a09080';
  _pinTimer = setTimeout(async () => {
    try {
      const res  = await fetch(`/.netlify/functions/pincode-lookup?pin=${val}`);
      const data = await res.json();
      // India Post has no record of this PIN. Checked BEFORE `data.state`,
      // because the lookup always guesses a state from the 3-digit prefix — so
      // a PIN like 206014 came back as {city:'', state:'Uttar Pradesh',
      // exists:false} and this branch treated it as a hit, autofilled the state
      // and asked for the city by hand. That is how a Lucknow address shipped
      // with a PIN no courier serves.
      //
      // WARN ONLY — never block here. India Post's dataset is incomplete: of 87
      // such pincodes across 8,274 real orders, most (452008 Indore, 122022
      // Gurgaon, 560114 …) are served by 22–37 couriers and 34 orders had
      // already been delivered. The order-creating functions do the real test
      // (zero couriers = refuse), so a stale postal dataset can never cost a
      // genuine sale.
      if (data && data.exists === false) {
        msg.textContent = '⚠ We couldn’t verify this pincode — please double-check it.';
        msg.style.color = '#c9a84c';
        msg.style.cursor = ''; msg.onclick = null;
        if (cityCol)  cityCol.style.display  = '';
        if (stateCol) stateCol.style.display = '';
        return;
      }
      if (res.ok && data.state) {
        if (data.city) document.getElementById('ch-city').value  = data.city;
        document.getElementById('ch-state').value = data.state;
        if (data.city) {
          msg.textContent = '✓ ' + data.city + ', ' + data.state + '  (edit)';
          msg.style.color = '#8fa87a';
          msg.style.cursor = 'pointer';
          msg.onclick = () => {
            if (cityCol)  cityCol.style.display  = '';
            if (stateCol) stateCol.style.display = '';
            msg.onclick = null; msg.style.cursor = '';
          };
          // Collapse the manual inputs — less mobile clutter; user can tap "edit".
          if (cityCol)  cityCol.style.display  = 'none';
          if (stateCol) stateCol.style.display = 'none';
          // Dismiss the mobile keyboard now that the address is complete.
          const pinEl = document.getElementById('ch-pin');
          if (pinEl) pinEl.blur();
        } else {
          msg.textContent = '✓ ' + data.state + ' — please enter your city.';
          msg.style.color = '#c9a84c';
          if (cityCol)  cityCol.style.display  = '';
          if (stateCol) stateCol.style.display = '';
        }
        checkProductShippingForPin(val);
        return;
      }
    } catch(e){}   // lookup unreachable → nothing to warn about, order proceeds
    checkProductShippingForPin(val);
    msg.textContent = 'Pincode not found — enter city and state manually.';
    msg.style.color = '#c97a7a';
    if (cityCol)  cityCol.style.display  = '';
    if (stateCol) stateCol.style.display = '';
  }, 500);
}

// ── Phone field hygiene ────────────────────────────────────────────────────
// Browser autofill mis-maps this field: on adjacent Full Name / Phone inputs it
// can treat the pair as given-name / family-name and drop a SURNAME into the
// phone box, `autocomplete="tel"` notwithstanding. The customer then sees a
// filled-looking field, gets "enter a valid 10-digit phone number" on submit,
// and reports there is no mobile field at all — because the one there looks done.
// (arvindsinghee@yahoo.in, 15 Aug 2026: two abandoned checkouts, both stored
// name "arvind" / phone "singhee". He never completed, and lost the sale price.)
//
// Stripping letters makes the bad value visibly vanish so the field reads empty
// and asks to be filled. Digits, +, spaces, dashes and brackets are kept: people
// legitimately type "+91 98765 43210", and truncating to 10 would silently
// mangle that into a wrong number.
function sanitizePhoneField(el) {
  if (!el) return;
  const cleaned = String(el.value || '').replace(/[^0-9+\\-\\s()]/g, '');
  if (cleaned !== el.value) el.value = cleaned;
}

// Point the customer at the field that is actually wrong. A bare alert() leaves
// them hunting, which is how "no option to enter mobile number" happens.
function failField(id, message) {
  alert(message);
  const el = document.getElementById(id);
  if (el) {
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) { el.scrollIntoView(); }
    el.focus({ preventScroll: true });
  }
  return null;
}

// ── Collect + validate address ─────────────────────────────────────────────
function collectAddr() {
  const get = id => document.getElementById(id)?.value.trim() || '';
  const name  = get('ch-name');
  const phone = get('ch-phone');
  const email = get('ch-email');
  // ch-addr is a textarea so customers can paste multi-line addresses from
  // Notes / Maps without losing lines below the first. Collapse line breaks
  // and runs of whitespace into single ", " separators for downstream consumers
  // (Shiprocket / NimbusPost / order emails expect a single-line string).
  const addr  = get('ch-addr').replace(/\\s*\\n+\\s*/g, ', ').replace(/\\s{2,}/g, ' ').replace(/(,\\s*){2,}/g, ', ').replace(/^,\\s*|,\\s*$/g, '').trim();
  const pin   = get('ch-pin').replace(/\\D/g,'');
  const city  = get('ch-city');
  const state = get('ch-state');

  if (!name)             { return failField('ch-name', 'Please enter your full name.'); }
  if (phone.replace(/\\D/g,'').length < 10) { return failField('ch-phone', 'Please enter a valid 10-digit mobile number.'); }
  if (!/^\\S+@\\S+\\.\\S+$/.test(email)) { return failField('ch-email', 'Please enter a valid email address.'); }
  if (!addr)             { return failField('ch-addr', 'Please enter your delivery address.'); }
  if (pin.length !== 6)  { return failField('ch-pin', 'Please enter a valid 6-digit pincode.'); }
  // Deliberately no client-side existence block: India Post's dataset is
  // incomplete and would turn away real customers. The order endpoints refuse
  // only pincodes NO courier serves, and their error surfaces here.

  // Normalise phone to digits only so DB lookups (My Orders / track) always match
  // — customers often type spaces or dashes ('87994 81113').
  const phoneDigits = phone.replace(/\\D/g, '');
  return {
    name, phone: phoneDigits, email,
    address: [addr, city, state, pin].filter(Boolean).join(', '),
    // The house/street line on its own. The savers below need it, and it CANNOT
    // be recovered from `address` by splitting on commas — see streetOf().
    street: addr,
    pincode: pin, city, state,
    // Consent travels with the order that captured it, so the server records
    // it against the same phone number the customer just confirmed.
    whatsapp_optin: !!document.getElementById('ch-wa-optin')?.checked,
  };
}

// ── Disable / enable buttons ───────────────────────────────────────────────
let _loadingMethod = '';
const CHECKOUT_FACTS = [
  'The word book is linked to old words for beech, because early writing tablets were sometimes made from wood.',
  'Paper was first developed in China nearly 2,000 years ago and helped stories travel farther.',
  'A bookmark is better for a book spine than folding page corners, especially for paperbacks.',
  'Reading a few pages before sleep can make a story feel more memorable because the mind keeps sorting it overnight.',
  'Movable type printing made books easier to produce and helped ideas spread across continents.',
  'Many bestselling books started as small print runs before readers turned them into long-term favourites.'
];
let _processingFactTimer = null;
let _processingFactIndex = 0;

function rotateProcessingFact() {
  const fact = document.getElementById('processingFact');
  if (!fact) return;
  fact.style.opacity = '0';
  setTimeout(() => {
    fact.textContent = CHECKOUT_FACTS[_processingFactIndex % CHECKOUT_FACTS.length];
    _processingFactIndex += 1;
    fact.style.opacity = '1';
  }, 180);
}

function showProcessing(method = 'online') {
  const overlay = document.getElementById('checkoutProcessing');
  if (!overlay) return;
  const kicker = document.getElementById('processingKicker');
  const title = document.getElementById('processingTitle');
  const copy = {
    online: ['Opening secure payment', 'Connecting to payment gateway...'],
    partial: ['Preparing partial payment', 'Setting up 10% prepaid checkout...'],
    cod: ['Saving your COD order', 'Placing your order...'],
  };
  const selected = copy[method] || ['Preparing checkout', 'Hold tight...'];
  if (kicker) kicker.textContent = selected[0];
  if (title) title.textContent = selected[1];
  rotateProcessingFact();
  clearInterval(_processingFactTimer);
  _processingFactTimer = setInterval(rotateProcessingFact, 2800);
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
}

function hideProcessing() {
  const overlay = document.getElementById('checkoutProcessing');
  clearInterval(_processingFactTimer);
  _processingFactTimer = null;
  if (!overlay) return;
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
}

function setLoading(on, method = '') {
  _loadingMethod = on ? method : '';
  if (on) showProcessing(method);
  else hideProcessing();
  const pay = document.getElementById('btnPayNow');
  const cod = document.getElementById('btnCOD');
  if (pay) {
    pay.disabled = on || _shippingRestrictionBlocked;
    pay.classList.toggle('is-loading', on && method === 'online');
  }
  const partial = document.getElementById('btnPartial');
  if (partial) {
    partial.disabled = on || _shippingRestrictionBlocked || !partialPaymentTotals(getCart()).eligible;
    partial.classList.toggle('is-loading', on && method === 'partial');
  }
  if (cod) {
    cod.disabled = on || _shippingRestrictionBlocked || cartHasNoCod(getCart()) || codShortfall() > 0;
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
  if (_shippingRestrictionBlocked) {
    alert(_shippingRestrictionText || 'A product in your cart cannot be delivered to this pincode.');
    return;
  }
  const addr = collectAddr();
  if (!addr) return;
  // Persist the address NOW (not only after a successful order) so a failed or
  // cancelled payment still restores the form when the customer returns.
  saveAddressLocally(addr);
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
  // Partial is COD-with-deposit — strip any prepaid-only coupon silently
  // (same UX as doCOD).
  if (appliedCouponCode) {
    const codCheck = couponDiscount(cart, 'cod');
    if (codCheck.discount <= 0 && codCheck.message) {
      const removed = appliedCouponCode;
      appliedCouponCode = '';
      try { localStorage.removeItem(COUPON_KEY); } catch (e) {}
      if (typeof appliedScratchCard !== 'undefined' && removed.startsWith('SCRATCH-')) {
        appliedScratchCard = null;
        try { localStorage.removeItem(SCRATCH_KEY); } catch (e) {}
      }
      if (typeof showToast === 'function') {
        showToast(removed + ' is prepaid-only — removed for partial COD.');
      }
      if (typeof renderSummary === 'function') renderSummary();
    }
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
        customer: { name: addr.name, phone: addr.phone, email: addr.email, address: addr.address, whatsapp_optin: addr.whatsapp_optin },
        payment_mode: isPartial ? 'partial_cod' : 'online',
        coupon: isPartial ? '' : (totals.discount > 0 ? totals.couponCode : ''),
        discount_grants: (window.iacDiscountGrants ? window.iacDiscountGrants() : []),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.success || !data.redirect_url) {
      throw new Error(data.error || 'Could not start PhonePe checkout');
    }
    // Stash the order value so the conversion on return (post-redirect) has revenue.
    try {
      localStorage.setItem('iac_last_order_value', String(totals.total));
      localStorage.setItem(CHECKOUT_CART_KEY, activeCartKey());
      stashPurchaseItems(cart, data.server_cart, isPartial ? 0 : totals.discount);   // the redirect unloads the page; stash now
      localStorage.setItem('iac_google_reviews_pending', JSON.stringify({
        order_id: data.order_id,
        email: addr.email || '',
        created_at: Date.now(),
      }));
    } catch(e) {}
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
    // create-order now recomputes amount server-side from cart slug + catalogue
    // (prevents client-side amount tampering that let one customer pay ₹1 for a
    // ₹799 order). We send cart + coupon + payment_mode; server returns the
    // authoritative Razorpay order with the true amount.
    const res = await fetch('/.netlify/functions/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cart: isPartial ? cartWithPaymentMeta(cart, paymentMeta) : cart,
        customer: { name: addr.name, phone: addr.phone, email: addr.email, address: addr.address, whatsapp_optin: addr.whatsapp_optin },
        coupon: isPartial ? '' : (totals.discount > 0 ? totals.couponCode : ''),
        payment_mode: isPartial ? 'partial_cod' : 'full',
        discount_grants: (window.iacDiscountGrants ? window.iacDiscountGrants() : []),
        notes: { customer_email: addr.email, customer_phone: addr.phone, customer_name: addr.name, shipping_address: addr.address || '', books: cart.map(i=>i.title||'').filter(Boolean).join(', ').slice(0,200) },
      }),
    });
    if (!res.ok) {
      let err = 'Order creation failed';
      try { const j = await res.json(); err = j.error || err; } catch (e) {}
      throw new Error(err);
    }
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
              discount_grants: (window.iacDiscountGrants ? window.iacDiscountGrants() : []),
              payment_mode: isPartial ? 'partial_cod' : 'online',
            }),
          });
          const verifiedOrder = await vRes.json().catch(() => ({}));
          if (!vRes.ok || !verifiedOrder.success) throw new Error('Verification failed');
          await saveAbandonedCheckout('converted', response.razorpay_order_id);
          localStorage.removeItem(ABANDONED_SESSION_KEY);
          saveAddressAfterOrder(addr);
          stashPurchaseItems(cart, verifiedOrder.server_cart || order.server_cart, isPartial ? 0 : totals.discount);   // must run BEFORE clearCart
          clearCart();
          await autoLogin(addr.email, addr.name, addr.phone);
          showSuccess('paid', response.razorpay_payment_id, addr, totals.total, verifiedOrder.order_id || response.razorpay_order_id);
        } catch(e) {
          alert('Payment received but verification failed. Please contact support@inkandchai.in');
          setLoading(false);
        }
      },
      modal: { ondismiss: () => setLoading(false) },
    };

    const rzp = new Razorpay(options);
    rzp.on('payment.failed', r => { alert('Payment failed: ' + r.error.description); setLoading(false); });
    hideProcessing();
    rzp.open();

  } catch(e) {
    alert('Could not start checkout: ' + e.message);
    setLoading(false);
  }
}

// ── Cash on Delivery ───────────────────────────────────────────────────────
async function doCOD(addr) {
  const cart     = getCart();
  // COD: silently drop any prepaid-only coupon instead of nagging the customer.
  // Static COUPONS marked onlineOnly (INKLOVE10, SAVE12, SAVE15, etc.) and
  // scratch cards are both prepaid-only. The previous behaviour blocked
  // checkout with an alert until the user removed the code by hand.
  if (appliedCouponCode) {
    const codCheck = couponDiscount(cart, 'cod');
    if (codCheck.discount <= 0 && codCheck.message) {
      const removed = appliedCouponCode;
      appliedCouponCode = '';
      try { localStorage.removeItem(COUPON_KEY); } catch (e) {}
      if (typeof appliedScratchCard !== 'undefined' && removed.startsWith('SCRATCH-')) {
        appliedScratchCard = null;
        try { localStorage.removeItem(SCRATCH_KEY); } catch (e) {}
      }
      if (typeof showToast === 'function') {
        showToast(removed + ' is prepaid-only — removed for Cash on Delivery.');
      }
      if (typeof renderSummary === 'function') renderSummary();
    }
  }
  const totals = orderTotals(cart, 'cod');

  try {
    const res = await fetch('/.netlify/functions/cod-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cart,
        customer: { name: addr.name, phone: addr.phone, email: addr.email, address: addr.address, whatsapp_optin: addr.whatsapp_optin },
        amount: totals.total, shipping: totals.shipping,
        discount_grants: (window.iacDiscountGrants ? window.iacDiscountGrants() : []),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to place order');

    await saveAbandonedCheckout('converted', data.order_id);
    localStorage.removeItem(ABANDONED_SESSION_KEY);
    saveAddressAfterOrder(addr);
    stashPurchaseItems(cart, data.server_cart, totals.discount);   // must run BEFORE clearCart
    clearCart();
    await autoLogin(addr.email, addr.name, addr.phone);
    showSuccess('cod', data.order_id, addr, totals.total);

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
function trackGoogleAdsPurchase(orderId, value) {
  if (!orderId || typeof gtag !== 'function') return;
  const key = 'iac_google_ads_purchase_' + orderId;
  if (localStorage.getItem(key)) return;
  // Fire purchase conversion to BOTH Google Ads accounts (old + new).
  // transaction_id de-dupes each conversion so it's counted once per account.
  // Include order value + currency so Ads gets revenue for ROAS / value bidding.
  const v = Number(value) || 0;
  const base = { transaction_id: String(orderId) };
  if (v > 0) { base.value = v; base.currency = 'INR'; }
  // Cart data — required for automated discounts, which uses it to pick which
  // products to discount, and for product-level reporting in Ads.
  try {
    const stash = JSON.parse(localStorage.getItem('iac_last_purchase_items') || '{}');
    if (stash && Array.isArray(stash.cart_data) && stash.cart_data.length) {
      base.aw_merchant_id = 5782474419;
      base.aw_feed_country = 'IN';
      base.aw_feed_language = 'en';
      base.discount = Number(stash.discount) || 0;
      base.items = stash.cart_data;
    }
  } catch (e) {}
  gtag('event', 'conversion', Object.assign({ send_to: 'AW-18119332653/dQPCCJ7L8KQcEK2m_L9D' }, base));
  gtag('event', 'conversion', Object.assign({ send_to: 'AW-18139908537/M2fkCNvV57ocELmT5MlD' }, base));
  localStorage.setItem(key, '1');
}

// GA4 ecommerce purchase. Separate from the Ads conversion above on purpose:
// send_to pins it to the GA4 property, because an event with no send_to goes to
// EVERY configured target — which would post a stray "purchase" into both Ads
// accounts as well.
//
// transaction_id is what GA4 de-dupes on, so a refresh of the success screen
// cannot count the sale twice; the localStorage key guards the same thing
// within a session.
const GA4_ID = 'GA4_MEASUREMENT_ID_PLACEHOLDER';
function trackGa4Purchase(orderId, value) {
  if (!GA4_ID || !orderId || typeof gtag !== 'function') return;
  const key = 'iac_ga4_purchase_' + orderId;
  try { if (localStorage.getItem(key)) return; } catch (e) {}
  const params = {
    send_to: GA4_ID,
    transaction_id: String(orderId),
    currency: 'INR',
    value: Number(value) || 0,
  };
  try {
    const stash = JSON.parse(localStorage.getItem('iac_last_purchase_items') || '{}');
    if (stash && Array.isArray(stash.cart_data) && stash.cart_data.length) {
      params.items = stash.cart_data.map(function (i) {
        return { item_id: String(i.id), price: Number(i.price) || 0, quantity: Number(i.quantity) || 1 };
      });
      // GA4 wants the coupon amount as a positive number on the transaction.
      const d = Number(stash.discount) || 0;
      if (d > 0) params.discount = d;
    }
  } catch (e) {}
  gtag('event', 'purchase', params);
  try { localStorage.setItem(key, '1'); } catch (e) {}
}

// Meta Purchase. Fires for BOTH pixels in one call, next to the Ads conversion
// so the two platforms can never disagree about what counted as a sale.
//
// COD COUNTS AT ORDER PLACEMENT, not on delivery — a deliberate choice. It
// means Meta's reported revenue includes COD orders that later RTO, so ROAS
// here reads higher than money actually banked. The trade is that Meta's
// optimiser gets the signal within seconds instead of days, which is what it
// needs to find buyers.
//
// content_ids come from stashPurchaseItems(), because every checkout path
// clears the cart before this runs.
function trackMetaPurchase(orderId, value) {
  if (!orderId || typeof window.iacMeta !== 'function') return;
  const params = { currency: 'INR', value: Number(value) || 0 };
  try {
    const stash = JSON.parse(localStorage.getItem('iac_last_purchase_items') || 'null');
    // Two hours: long enough for a slow PhonePe redirect, short enough that a
    // stale basket from an abandoned attempt cannot attach itself to a later order.
    if (stash && Date.now() - Number(stash.ts || 0) < 2 * 60 * 60 * 1000) {
      if (stash.ids && stash.ids.length) {
        params.content_ids = stash.ids;
        params.content_type = 'product';
      }
      if (stash.num_items) params.num_items = stash.num_items;
    }
    localStorage.removeItem('iac_last_purchase_items');
  } catch (e) {}
  window.iacMeta('Purchase', params, 'iac_meta_purchase_' + orderId);
}

// Called immediately before clearCart() on every checkout path (and before the
// PhonePe redirect, where the cart has to survive a page load).
function stashPurchaseItems(cart, serverCart, discountRs) {
  try {
    const ids = window.iacMetaIds ? window.iacMetaIds(cart) : [];
    const num = (cart || []).reduce((s, i) => s + (Number(i.qty) || 1), 0);
    localStorage.setItem('iac_last_purchase_items',
      JSON.stringify({
        ids: ids, num_items: num, ts: Date.now(),
        cart_data: cartDataItems(serverCart || cart),
        // Reported separately so the line prices and the order value reconcile:
        // items carry the per-unit price charged, and a coupon comes off here.
        discount: Number(discountRs) || 0,
      }));
  } catch (e) {}
}

// Google Ads "conversions with cart data". The ids MUST match the Merchant
// Center feed exactly, and only the server knows which feed a product is in —
// so these come from server_cart (_offer_id, stamped in utils/pricing.js) and
// fall back to the slug, which is the id for the static catalogue.
function cartDataItems(cart) {
  return (cart || []).map(function (i) {
    var id = i._offer_id || i.slug || '';
    return id ? { id: String(id), price: Number(i.price) || 0, quantity: Number(i.qty) || 1 } : null;
  }).filter(Boolean);
}

function showSuccess(type, orderId, addr, value, surveyOrderId = orderId) {
  hideProcessing();
  trackGoogleAdsPurchase(orderId, value);
  // Before trackMetaPurchase — that one clears the item stash both of these read.
  trackGa4Purchase(orderId, value);
  trackMetaPurchase(orderId, value);
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
    </div>` : (addr.phone ? `
    <div class="success-email-box">
      <p style="font-size:0.68rem;color:var(--gold);margin-bottom:0.35rem;letter-spacing:0.07em;">
        💬 Confirmation sent on WhatsApp to +91 ${esc(String(addr.phone).slice(-10))}
      </p>
      <p style="font-size:0.64rem;color:var(--cream-dim);line-height:1.75;margin:0;">
        Your order details are on WhatsApp. You can also sign in and open
        <strong style="color:var(--white);">My Orders</strong> on
        <a href="/" style="color:var(--gold);">inkandchai.in</a> to track this order anytime.
      </p>
    </div>` : '')}
    <div id="scratchCardSlot"></div>
    <a href="/" class="btn-home">← Continue Shopping</a>
  `;

  window.IACGoogleCustomerReviews?.render({
    orderId: surveyOrderId,
    email: addr.email,
  });

  // ── Scratch card reward (prepaid only) ─────────────────────────────────
  if (isPaid) loadScratchCard(orderId);
}

// ── Scratch card UI ──────────────────────────────────────────────────────
async function loadScratchCard(orderId, attempts = 0) {
  const slot = document.getElementById('scratchCardSlot');
  if (!slot) return;
  try {
    const r = await fetch('/.netlify/functions/scratch-card?order_id=' + encodeURIComponent(orderId));
    const j = await r.json();
    if (!j.card) {
      // Webhook may not have written the card yet — retry up to ~10s
      if (attempts < 5) { setTimeout(() => loadScratchCard(orderId, attempts + 1), 2000); }
      return;
    }
    renderScratchCard(slot, j.card);
  } catch (e) { console.warn('[scratch] load failed:', e); }
}

function renderScratchCard(slot, card) {
  const isScratched = card.status !== 'unscratched';
  const exp = card.expires_at ? new Date(card.expires_at) : null;
  const expStr = exp ? exp.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }) : '';
  const minOrder = card.min_subtotal_paise ? '₹' + (card.min_subtotal_paise/100).toLocaleString('en-IN') : '₹399';

  slot.innerHTML = `
    <div class="scratch-wrap">
      <div class="scratch-title">You won a reward! 🎁</div>
      <div class="scratch-hint">${isScratched ? 'Your coupon below' : 'Scratch the card to reveal'}</div>
      <div class="scratch-card" id="sCard">
        <div class="scratch-prize">
          <div class="scratch-prize-amt" id="sAmt">${isScratched ? '₹' + (card.value_paise/100) : '✦'}</div>
          <div class="scratch-prize-label">cashback coupon</div>
          <div class="scratch-prize-code">${card.code}</div>
          <div class="scratch-prize-exp">Min order ${minOrder} · Expires ${expStr}</div>
        </div>
        <canvas class="scratch-canvas" id="sCanvas" width="280" height="280"></canvas>
      </div>
      <button class="scratch-copy-btn" id="sCopy" style="display:${isScratched ? 'inline-block' : 'none'};"
        onclick="navigator.clipboard.writeText('${card.code}').then(()=>{this.textContent='Copied ✓';setTimeout(()=>this.textContent='Copy code',1500)})">
        Copy code
      </button>
    </div>
  `;

  if (isScratched) return;
  initScratchCanvas(card);
}

function initScratchCanvas(card) {
  const canvas = document.getElementById('sCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // Paint gold gradient overlay
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0,    '#c9a84c');
  grad.addColorStop(0.5,  '#a98224');
  grad.addColorStop(1,    '#8a6a1f');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // "SCRATCH HERE" text + sparkle
  ctx.fillStyle = 'rgba(36, 27, 19, 0.65)';
  ctx.font = '600 14px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.letterSpacing = '4px';
  ctx.fillText('✦  SCRATCH HERE  ✦', W/2, H/2 - 8);
  ctx.font = '300 10px Inter, sans-serif';
  ctx.fillText('Drag your finger to reveal', W/2, H/2 + 16);

  ctx.globalCompositeOperation = 'destination-out';

  let drawing = false;
  let lastX = 0, lastY = 0;

  function pos(e) {
    const r = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: (t.clientX - r.left) * (W/r.width), y: (t.clientY - r.top) * (H/r.height) };
  }
  function start(e) { e.preventDefault(); drawing = true; const p = pos(e); lastX = p.x; lastY = p.y; }
  function move(e)  {
    if (!drawing) return;
    e.preventDefault();
    const p = pos(e);
    ctx.lineWidth = 36; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(p.x, p.y); ctx.stroke();
    lastX = p.x; lastY = p.y;
    checkReveal();
  }
  function end() { drawing = false; }

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  canvas.addEventListener('mouseup',   end);
  canvas.addEventListener('mouseleave',end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove',  move,  { passive: false });
  canvas.addEventListener('touchend',   end);

  let revealed = false;
  async function checkReveal() {
    if (revealed) return;
    // Sample pixels — if >55% transparent, reveal
    const img = ctx.getImageData(0, 0, W, H).data;
    let transparent = 0;
    for (let i = 3; i < img.length; i += 40) { if (img[i] < 60) transparent++; }
    const pct = transparent / (img.length / 40);
    if (pct > 0.55) {
      revealed = true;
      try {
        const r = await fetch('/.netlify/functions/scratch-card', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'scratch', code: card.code }),
        });
        const j = await r.json();
        if (j.success) {
          document.getElementById('sAmt').textContent = '₹' + (j.value_paise/100);
          document.getElementById('sCard').classList.add('revealed');
          document.getElementById('sCopy').style.display = 'inline-block';
          fireConfetti(j.value_paise);
        }
      } catch (e) { console.warn('[scratch] reveal failed:', e); }
    }
  }
}

function fireConfetti(valuePaise) {
  const card = document.getElementById('sCard');
  if (!card) return;
  const colors = ['#c9a84c','#f0e8d8','#a98224','#8a6a1f','#e8a030'];
  const count = valuePaise >= 10000 ? 60 : 28;  // BIG WIN → more confetti
  for (let i = 0; i < count; i++) {
    const d = document.createElement('div');
    d.className = 'confetti';
    d.style.background = colors[i % colors.length];
    d.style.left = (Math.random() * 100) + '%';
    d.style.top  = '-20px';
    d.style.animationDelay = (Math.random() * 0.5) + 's';
    d.style.transform = `rotate(${Math.random() * 360}deg)`;
    card.appendChild(d);
    setTimeout(() => d.remove(), 2200);
  }
}

// ── PhonePe redirect-back handler ──────────────────────────────────────────
// PhonePe → /phonepe-verify-status → /checkout/?paid=1&id=… (or ?failed=1)
(function() {
  const p = new URLSearchParams(location.search);
  if (p.get('paid') === '1' && p.get('id')) {
    // Save address from form fields if still populated (same-tab PhonePe redirect)
    try {
      const get = id => document.getElementById(id)?.value?.trim() || '';
      const addrForSave = {
        name: get('ch-name'), phone: get('ch-phone'), email: get('ch-email'),
        address: get('ch-addr'), pincode: get('ch-pin'), city: get('ch-city'), state: get('ch-state'),
      };
      if (addrForSave.phone || addrForSave.name) saveAddressAfterOrder(addrForSave);
    } catch(e) {}
    clearCart();
    // Recover the short-lived survey payload saved immediately before PhonePe redirect.
    let savedEmail = '';
    try {
      const pending = JSON.parse(localStorage.getItem('iac_google_reviews_pending') || '{}');
      const isMatchingOrder = String(pending.order_id || '') === p.get('id');
      const isFresh = Date.now() - Number(pending.created_at || 0) < 24 * 60 * 60 * 1000;
      if (isMatchingOrder && isFresh) savedEmail = pending.email || '';
      localStorage.removeItem('iac_google_reviews_pending');
    } catch {}
    // Order value for the Ads conversion. The server puts it on the return URL
    // (?v=), which survives the redirect no matter which browser the customer
    // lands back in. localStorage is only a fallback now: it is empty whenever
    // the checkout started in an in-app browser and PhonePe handed back to the
    // default one, and a conversion fired without a value makes Ads substitute
    // the conversion action's default value.
    let savedValue = Number(p.get('v')) || 0;
    try {
      if (!savedValue) savedValue = Number(localStorage.getItem('iac_last_order_value')) || 0;
      localStorage.removeItem('iac_last_order_value');
    } catch {}
    showSuccess('paid', p.get('id'), { email: savedEmail }, savedValue);
    // Clean URL so refresh doesn't re-trigger success
    history.replaceState({}, '', '/checkout/');
    return;
  }
  if (p.get('failed') === '1') {
    try { localStorage.removeItem('iac_google_reviews_pending'); } catch {}
    const code = p.get('code') || '';
    setTimeout(() => alert('PhonePe payment was cancelled or failed' + (code ? ' (' + code + ')' : '') + '. Please try again or use Cash on Delivery.'), 100);
    history.replaceState({}, '', '/checkout/');
  }
})();

// ── Google Shopping ?buy=SLUG handler ─────────────────────────────────────
// When a customer arrives from Google Shopping via the checkout_link_template
// (https://inkandchai.in/checkout/?buy={id}), pre-load that book into the cart.
(async () => {
  const buyId = new URLSearchParams(location.search).get('buy');
  if (!buyId) return;
  try {
    const res = await fetch('/.netlify/functions/get-book?id=' + encodeURIComponent(buyId));
    if (!res.ok) return;
    const book = await res.json();
    if (!book || !book.title) return;
    const item = {
      id:     book.slug,
      url:    book.slug,
      title:  book.title,
      author: book.author || '',
      price:  book.price,
      img:    book.img || '',
      qty:    1,
    };
    // Set as buy-now so checkout shows just this item
    localStorage.setItem(BUY_NOW_KEY, JSON.stringify([item]));
    // Clean ?buy= from URL so refresh doesn't re-trigger
    history.replaceState({}, '', '/checkout/');
    renderSummary();
  } catch (e) { /* silently ignore — customer can add manually */ }
})();

// ── Saved address helpers ──────────────────────────────────────────────────
const SAVED_ADDR_KEY = 'iac_saved_address';

/**
 * The house/street line on its own, for the savers that store it separately
 * from city/state/pincode.
 *
 * This used to be `address.split(',')[0]`, which was wrong in the most ordinary
 * case there is: `address` is "<street>, <city>, <state>, <pin>" and the street
 * a customer types almost always contains a comma of its own — "Room 312, AHS
 * Hostel", "Flat 4B, Sunrise Apartments". Taking the first segment threw away
 * everything after the first comma, so the saved copy was a fragment, and the
 * NEXT order autofilled that fragment and shipped to an incomplete address.
 *
 * Prefer the raw field collectAddr() now carries. Only fall back to unpicking
 * the joined string, and do that by dropping trailing segments that exactly
 * match the city/state/pincode we appended ourselves — never by cutting at the
 * first comma. Dropping only exact matches is what keeps an address whose street
 * ends in its own city name ("…bhadrakali Hooghly, Hooghly, West Bengal") intact.
 */
function streetOf(addr) {
  const raw = String(addr?.street || '').trim();
  if (raw) return raw;

  const joined = String(addr?.address || '').trim();
  const parts = joined.split(',');
  // Reverse of the order they were appended in: city, state, pin.
  for (const part of [addr?.pincode, addr?.state, addr?.city]) {
    const token = String(part || '').trim().toLowerCase();
    if (!token || parts.length <= 1) continue;
    if (parts[parts.length - 1].trim().toLowerCase() === token) parts.pop();
  }
  return parts.join(',').trim().replace(/,+$/, '').trim() || joined;
}

function saveAddressLocally(addr) {
  try {
    localStorage.setItem(SAVED_ADDR_KEY, JSON.stringify({
      name: addr.name, phone: addr.phone, email: addr.email,
      addr: streetOf(addr),   // just house/street part
      pincode: addr.pincode, city: addr.city, state: addr.state,
    }));
  } catch(e) {}
}

async function saveAddressToProfile(addr) {
  if (!window.supabase || !window.SUPABASE_URL || window.SUPABASE_URL === ('SUPABASE_URL'+'_PLACEHOLDER')) return;
  try {
    const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    await sb.from('profiles').upsert({
      id:      session.user.id,
      name:    addr.name,
      phone:   addr.phone,
      address: streetOf(addr),
      pincode: addr.pincode,
      city:    addr.city,
      state:   addr.state,
    }, { onConflict: 'id' });
  } catch(e) {}
}

// Call after every successful order (COD or paid)
function saveAddressAfterOrder(addr) {
  saveAddressLocally(addr);
  saveAddressToProfile(addr);
  saveAddressToBook(addr).catch(e => console.warn('[addr-book] save failed:', e));
}

// ── Multi-address book (Supabase customer_addresses table) ─────────────────
let _checkoutSB = null;
async function getCheckoutSupabase() {
  if (_checkoutSB) return _checkoutSB;
  if (!window.supabase || !window.SUPABASE_URL || window.SUPABASE_URL === ('SUPABASE_URL'+'_PLACEHOLDER')) return null;
  // Singleton: creating a new client per call spawns duplicate auth listeners that
  // re-fire onAuthStateChange -> refreshAddressBook -> new client -> infinite loop
  // of customer_addresses queries. Reuse one client.
  _checkoutSB = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  return _checkoutSB;
}

// Normalised key used to dedupe addresses (same house+pincode = same address)
function addrFingerprint(a) {
  return [(a.address||'').toLowerCase().replace(/\s+/g,' ').trim(),
          (a.pincode||'').trim()].join('|');
}

async function loadAddressBook() {
  const sb = await getCheckoutSupabase();
  if (!sb) return [];
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return [];
    const { data, error } = await sb
      .from('customer_addresses')
      .select('*')
      .order('last_used_at', { ascending: false })
      .limit(20);
    if (error) { console.warn('[addr-book] load error:', error.message); return []; }
    return data || [];
  } catch(e) { console.warn('[addr-book] load exception:', e.message); return []; }
}

async function saveAddressToBook(addr) {
  const sb = await getCheckoutSupabase();
  if (!sb) return;
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;

  const street = streetOf(addr);
  if (!street || !addr.name) return;

  // Dedupe: if same fingerprint exists, just bump last_used_at instead of inserting
  const fp = addrFingerprint({ address: street, pincode: addr.pincode });
  const { data: existing } = await sb
    .from('customer_addresses').select('*')
    .eq('user_id', session.user.id);
  const match = (existing || []).find(a => addrFingerprint(a) === fp);
  if (match) {
    await sb.from('customer_addresses')
      .update({ last_used_at: new Date().toISOString(), name: addr.name, phone: addr.phone, city: addr.city, state: addr.state })
      .eq('id', match.id);
    return;
  }

  // Insert as new entry; first-ever address becomes default
  const isFirst = !(existing && existing.length);
  await sb.from('customer_addresses').insert({
    user_id:    session.user.id,
    name:       addr.name,
    phone:      addr.phone || null,
    address:    street,
    pincode:    addr.pincode || null,
    city:       addr.city || null,
    state:      addr.state || null,
    is_default: isFirst,
  });
}

async function deleteAddressFromBook(id) {
  const sb = await getCheckoutSupabase();
  if (!sb) return;
  await sb.from('customer_addresses').delete().eq('id', id);
}

function fillCheckoutFormFromAddress(a) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  set('ch-name',  a.name);
  set('ch-phone', a.phone);
  set('ch-addr',  a.address);
  set('ch-pin',   a.pincode);
  set('ch-city',  a.city);
  set('ch-state', a.state);
  // Trigger any listeners (renderSummary etc.)
  ['ch-name','ch-phone','ch-addr','ch-pin','ch-city','ch-state'].forEach(id => {
    document.getElementById(id)?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function escAttr(s) { return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

function renderAddressBook(addresses) {
  const wrap = document.getElementById('addrBook');
  const list = document.getElementById('addrBookList');
  const formSection = document.querySelector('.form-section');
  if (!wrap || !list) return;

  if (!addresses.length) {
    wrap.style.display = 'none';
    if (formSection) formSection.style.display = '';
    return;
  }

  // Show the saved-address picker, but KEEP the payment form + buttons visible
  // below it (the buttons live inside .form-section). Pre-fill with the default
  // address so the user can pay in one tap, or tap another saved card to switch.
  wrap.style.display = 'block';
  if (formSection) formSection.style.display = '';
  const nameEl = document.getElementById('ch-name');
  if (nameEl && !nameEl.value.trim()) {
    const def = addresses.find(a => a.is_default) || addresses[0];
    if (def) fillCheckoutFormFromAddress(def);
  }

  list.innerHTML = addresses.map((a, i) => {
    const label = a.label ? a.label
                : i === 0 && a.is_default ? 'Default'
                : `Address ${i + 1}`;
    return `
      <div class="addr-card" data-id="${escAttr(a.id)}" onclick="pickSavedAddress('${escAttr(a.id)}')"
        style="cursor:pointer;border:1px solid var(--border);background:var(--bg2);padding:0.9rem 1rem;position:relative;transition:border-color 0.15s;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:0.5rem;margin-bottom:0.4rem;">
          <strong style="font-size:0.78rem;color:var(--gold);font-weight:500;">${escAttr(label)}</strong>
          <button type="button" onclick="event.stopPropagation();removeSavedAddress('${escAttr(a.id)}')" title="Delete address"
            style="background:transparent;border:none;color:var(--cream-dim);cursor:pointer;font-size:0.65rem;line-height:1;padding:0;opacity:0.6;">✕</button>
        </div>
        <div style="font-size:0.78rem;color:var(--cream);font-weight:500;">${escAttr(a.name)}</div>
        <div style="font-size:0.7rem;color:var(--cream-dim);line-height:1.55;margin-top:0.2rem;">
          ${escAttr(a.address)}<br/>
          ${escAttr(a.city||'')}${a.city && a.state ? ', ' : ''}${escAttr(a.state||'')} ${escAttr(a.pincode||'')}<br/>
          ${a.phone ? `📞 ${escAttr(a.phone)}` : ''}
        </div>
      </div>`;
  }).join('');
}

// In-memory cache so picker doesn't refetch on every click
let _addressBookCache = [];

async function refreshAddressBook() {
  _addressBookCache = await loadAddressBook();
  renderAddressBook(_addressBookCache);
}

window.pickSavedAddress = function(id) {
  const a = _addressBookCache.find(x => x.id === id);
  if (!a) return;
  fillCheckoutFormFromAddress(a);
  // Form + buttons are already visible; just highlight the choice and jump to pay.
  document.querySelectorAll('#addrBookList .addr-card').forEach(c => {
    c.style.borderColor = c.dataset.id === id ? 'var(--gold)' : 'var(--border)';
  });
  document.getElementById('btnPayNow')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

window.removeSavedAddress = async function(id) {
  if (!confirm('Remove this address from your account?')) return;
  await deleteAddressFromBook(id);
  await refreshAddressBook();
};

window.addrShowNewForm = function() {
  const wrap = document.getElementById('addrBook');
  const formSection = document.querySelector('.form-section');
  if (wrap) wrap.style.display = 'none';
  if (formSection) formSection.style.display = '';
  // Scroll to form
  formSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// ── Init ───────────────────────────────────────────────────────────────────
loadManagedPromotions().then(() => loadProductCoupons(getCart())).then(renderSummary);
renderSummary();

// When returning to checkout — including bfcache back/forward from a payment
// page (PhonePe redirect, Razorpay) — clear any stuck loading state and repaint
// so Pay Now / COD / Partial COD are clickable again.
window.addEventListener('pageshow', () => {
  setLoading(false);
  renderSummary();
  const pin = document.getElementById('ch-pin')?.value?.replace(/\\D/g, '') || '';
  if (pin.length === 6) checkProductShippingForPin(pin);
});

['ch-name','ch-phone','ch-email','ch-addr','ch-pin','ch-city','ch-state'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', scheduleAbandonedCapture);
  el.addEventListener('blur', () => saveAbandonedCheckout('open'));
});

// Load saved address book on page open + whenever auth state changes
refreshAddressBook();
(async () => {
  const sb = await getCheckoutSupabase();
  if (!sb) return;
  sb.auth.onAuthStateChange(() => { refreshAddressBook(); });
})();

// Pre-fill address: sessionStorage cache → Supabase profile → localStorage fallback
function showAutofillBanner(name) {
  const banner = document.getElementById('autofillBanner');
  const nameEl = document.getElementById('autofillName');
  if (banner) { banner.style.display = 'flex'; }
  if (nameEl && name) nameEl.textContent = name;
}
function clearAutofill() {
  const banner = document.getElementById('autofillBanner');
  if (banner) banner.style.display = 'none';
  ['ch-name','ch-phone','ch-email','ch-addr','ch-pin','ch-city','ch-state'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const pinMsg = document.getElementById('pinMsg');
  if (pinMsg) pinMsg.textContent = '';
}

(async () => {
  const fill = (id, val) => { const el = document.getElementById(id); if (el && val && !el.value) el.value = val; };

  function applyProfile(name, email, phone, address, pincode, city, state) {
    fill('ch-name',  name);
    fill('ch-email', email);
    fill('ch-phone', phone);
    fill('ch-addr',  address);
    fill('ch-pin',   pincode);
    fill('ch-city',  city);
    fill('ch-state', state);
    if (pincode && city && state) {
      const pinMsg = document.getElementById('pinMsg');
      if (pinMsg && !pinMsg.textContent) {
        pinMsg.textContent = '✓ ' + city + ', ' + state;
        pinMsg.style.color = '#8fa87a';
      }
    }
    if (name || address) showAutofillBanner(name);
    // Programmatic profile autofill does not emit the input event used by
    // handlePin(). Check the populated PIN explicitly so restricted products
    // disable every payment button as soon as checkout opens.
    const normalizedPin = String(pincode || '').replace(/\\D/g, '');
    if (normalizedPin.length === 6) checkProductShippingForPin(normalizedPin);
  }

  // 1. sessionStorage cache (instant — set by auth.js on main site)
  try {
    const cached = JSON.parse(sessionStorage.getItem('iac_profile_cache') || 'null');
    if (cached && (cached.name || cached.address)) {
      applyProfile(cached.name, cached.email || '', cached.phone, cached.address, cached.pincode, cached.city, cached.state);
      // Update auth button to show name
      const btn = document.getElementById('chkAuthBtn');
      if (btn && cached.name) btn.textContent = '👤 ' + cached.name.split(' ')[0];
      return;
    }
  } catch(e) {}

  // 2. Supabase profile (logged-in users on fresh sessions)
  if (window.supabase && window.SUPABASE_URL && window.SUPABASE_URL !== ('SUPABASE_URL'+'_PLACEHOLDER')) {
    try {
      const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
      const { data: { session } } = await sb.auth.getSession();
      if (session) {
        // Update auth button
        const btn = document.getElementById('chkAuthBtn');
        if (btn) btn.textContent = '👤 ' + (session.user.email?.split('@')[0] || 'Account');

        const { data: profile } = await sb.from('profiles').select('*').eq('id', session.user.id).single();
        if (profile && (profile.name || profile.address)) {
          applyProfile(profile.name, session.user?.email, profile.phone, profile.address, profile.pincode, profile.city, profile.state);
          // Cache for next visit
          try { sessionStorage.setItem('iac_profile_cache', JSON.stringify({...profile, email: session.user.email})); } catch(e2) {}
          return;
        }
      }
    } catch(e) {}
  }

  // 3. Fallback: localStorage saved address (guests + previous orders)
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_ADDR_KEY) || 'null');
    if (saved && (saved.name || saved.addr)) {
      applyProfile(saved.name, saved.email, saved.phone, saved.addr, saved.pincode, saved.city, saved.state);
    }
  } catch(e) {}
})();

// ── Checkout auth modal (minimal — just Google + OTP) ─────────────────────
function chkOpenAuth() {
  if (!window.supabase || !window.SUPABASE_URL || window.SUPABASE_URL === ('SUPABASE_URL'+'_PLACEHOLDER')) return;
  const existing = document.getElementById('chkAuthModal');
  if (existing) { existing.remove(); return; }
  const modal = document.createElement('div');
  modal.id = 'chkAuthModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(13,11,8,0.94);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;z-index:10010;padding:1rem;';
  modal.innerHTML = `
    <div style="background:#1c1916;border:1px solid rgba(201,168,76,0.22);width:min(400px,96vw);padding:2.2rem;position:relative;">
      <button onclick="document.getElementById('chkAuthModal').remove()"
        style="position:absolute;top:1rem;right:1.2rem;background:none;border:none;color:#a09080;font-size:1.3rem;cursor:pointer;">✕</button>
      <div style="font-size:.55rem;letter-spacing:.35em;text-transform:uppercase;color:#c9a84c;margin-bottom:.4rem;">Ink &amp; Chai</div>
      <h3 style="font-family:'Cormorant Garamond',serif;font-size:1.7rem;font-weight:300;color:#faf7f2;margin-bottom:.4rem;">Sign in to autofill</h3>
      <p style="font-size:.68rem;color:#a09080;margin-bottom:1.4rem;line-height:1.6;">Your saved name, address and phone will fill in automatically.</p>

      <button onclick="chkGoogleSignIn()"
        style="width:100%;padding:.85rem;background:#fff;color:#3c3c3c;font-family:'Inter',sans-serif;
               font-size:.65rem;letter-spacing:.12em;text-transform:uppercase;border:none;cursor:pointer;
               font-weight:600;display:flex;align-items:center;justify-content:center;gap:.7rem;margin-bottom:.8rem;">
        <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
        Continue with Google
      </button>

      <div style="display:flex;align-items:center;gap:.8rem;margin:.4rem 0 .8rem;">
        <div style="flex:1;height:1px;background:rgba(201,168,76,0.15);"></div>
        <span style="font-size:.58rem;color:#a09080;">OR</span>
        <div style="flex:1;height:1px;background:rgba(201,168,76,0.15);"></div>
      </div>

      <input id="chkOtpEmail" type="email" placeholder="your@email.com" autocomplete="email"
        style="width:100%;background:#141210;border:1px solid rgba(201,168,76,0.18);color:#f0e8d8;
               padding:.75rem 1rem;font-family:'Inter',sans-serif;font-size:16px;outline:none;margin-bottom:.6rem;"
        onkeydown="if(event.key==='Enter')chkSendOtp()"
        onfocus="this.style.borderColor='rgba(201,168,76,0.5)'" onblur="this.style.borderColor='rgba(201,168,76,0.18)'"/>
      <button onclick="chkSendOtp()" id="chkOtpBtn"
        style="width:100%;padding:.85rem;background:#c9a84c;color:#0d0b08;font-family:'Inter',sans-serif;
               font-size:.65rem;letter-spacing:.25em;text-transform:uppercase;border:none;cursor:pointer;font-weight:600;">
        Send OTP →
      </button>
      <p id="chkOtpMsg" style="font-size:.7rem;margin-top:.6rem;min-height:1em;text-align:center;color:#a09080;"></p>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
  setTimeout(() => document.getElementById('chkOtpEmail')?.focus(), 80);
}

async function chkGoogleSignIn() {
  const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href, queryParams: { prompt: 'select_account' } },
  });
  if (error) alert('Google sign-in error: ' + error.message);
}

let _chkOtpEmail = '';
async function chkSendOtp() {
  const email = document.getElementById('chkOtpEmail')?.value.trim() || '';
  const msg   = document.getElementById('chkOtpMsg');
  const btn   = document.getElementById('chkOtpBtn');
  if (!email || !/\\S+@\\S+\\.\\S+/.test(email)) { if(msg){msg.style.color='#e06060';msg.textContent='Enter a valid email.';} return; }
  const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  if (btn) { btn.disabled=true; btn.textContent='Sending…'; }
  try {
    await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    _chkOtpEmail = email;
    // Show OTP boxes
    const box = document.getElementById('chkAuthModal')?.querySelector('div');
    if (box) box.innerHTML += `
      <p style="font-size:.7rem;color:#a09080;margin-top:.8rem;">Enter the 8-digit code sent to <strong style="color:#c9a84c">${email}</strong></p>
      <div style="display:flex;gap:.4rem;margin:.6rem 0;">
        ${[0,1,2,3,4,5,6,7].map(i=>`<input id="cOtp${i}" type="text" inputmode="numeric" maxlength="1"
          style="flex:1;height:44px;text-align:center;font-size:1.2rem;font-weight:600;background:#141210;
                 border:1px solid rgba(201,168,76,0.25);color:#f0e8d8;font-family:'Inter',sans-serif;outline:none;"
          oninput="(function(el,i){el.value=el.value.replace(/\\\\D/g,'').slice(-1);if(el.value&&i<7)document.getElementById('cOtp'+(i+1))?.focus();const c=[0,1,2,3,4,5,6,7].map(j=>document.getElementById('cOtp'+j)?.value||'').join('');if(c.length===8)chkVerifyOtp();})(this,${i})"
          onkeydown="if(event.key==='Backspace'&&!this.value&&${i}>0)document.getElementById('cOtp'+(${i}-1))?.focus()"/>`).join('')}
      </div>
      <p id="chkVerifyMsg" style="font-size:.7rem;color:#e06060;min-height:1em;"></p>`;
    setTimeout(() => document.getElementById('cOtp0')?.focus(), 50);
  } catch(e) {
    if(msg){msg.style.color='#e06060';msg.textContent=e.message||'Error sending code.';}
    if(btn){btn.disabled=false;btn.textContent='Send OTP →';}
  }
}

async function chkVerifyOtp() {
  const code = [0,1,2,3,4,5,6,7].map(i=>document.getElementById('cOtp'+i)?.value||'').join('');
  const msg  = document.getElementById('chkVerifyMsg');
  if (code.length < 8) { if(msg){msg.textContent='Enter all 8 digits.';} return; }
  const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  try {
    const { data, error } = await sb.auth.verifyOtp({ email: _chkOtpEmail, token: code, type: 'email' });
    if (error) throw error;
    document.getElementById('chkAuthModal')?.remove();
    // Reload profile and prefill
    const { data: profile } = await sb.from('profiles').select('*').eq('id', data.user.id).single();
    if (profile && (profile.name || profile.phone)) {
      const fill = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
      fill('ch-name', profile.name); fill('ch-email', data.user.email);
      fill('ch-phone', profile.phone); fill('ch-addr', profile.address);
      fill('ch-pin', profile.pincode); fill('ch-city', profile.city); fill('ch-state', profile.state);
      showAutofillBanner(profile.name);
    }
    const btn = document.getElementById('chkAuthBtn');
    if (btn) btn.textContent = '👤 ' + ((profile?.name||data.user.email||'').split(' ')[0]);
  } catch(e) {
    if(msg){msg.textContent=e.message||'Invalid code.';}
  }
}
</script>
</body>
</html>"""

# The homepage template is stripped where it is defined; checkout is stripped
# here, before its placeholders are filled, so an ended sale never reaches a
# freshly built page at all.
CHECKOUT_HTML = strip_expired_sale(CHECKOUT_HTML)
CHECKOUT_HTML = CHECKOUT_HTML.replace("RAZORPAY_PUB_KEY_PLACEHOLDER", razorpay_key)
CHECKOUT_HTML = CHECKOUT_HTML.replace("SUPABASE_URL_PLACEHOLDER",     os.environ.get("SUPABASE_URL", ""))
CHECKOUT_HTML = CHECKOUT_HTML.replace("SUPABASE_ANON_KEY_PLACEHOLDER",os.environ.get("SUPABASE_ANON_KEY", ""))
CHECKOUT_HTML = CHECKOUT_HTML.replace("GA4_MEASUREMENT_ID_PLACEHOLDER", GA4_MEASUREMENT_ID)

checkout_out = Path(__file__).parent / "public" / "checkout" / "index.html"
checkout_out.parent.mkdir(parents=True, exist_ok=True)
checkout_out.write_text(with_meta_pixel(with_page_loader(CHECKOUT_HTML)), encoding="utf-8")
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
<link href="FONT_GOOGLE_URL_SIMPLE_PLACEHOLDER" rel="stylesheet"/>
<script>
  (function(){ var d = document.documentElement; try { if (localStorage.getItem('iac_theme') !== 'dark') d.setAttribute('data-theme','light'); } catch(e){ d.setAttribute('data-theme','light'); /* light default */ } })();
  function toggleTheme(){ var c = document.documentElement.getAttribute('data-theme'); var n = c === 'light' ? 'dark' : 'light'; if(n) document.documentElement.setAttribute('data-theme', n); else document.documentElement.removeAttribute('data-theme'); try { localStorage.setItem('iac_theme', n); } catch(e){} }
</script>
<style>
:root{--bg:#0d0b08;--bg2:#141210;--bg3:#1c1916;--gold:#c9a84c;--gold-light:#e8c97a;--gold-dim:#7a6330;--cream:#f0e8d8;--cream-dim:#a09080;--white:#faf7f2;--border:rgba(201,168,76,0.18)}
html[data-theme="light"]{--bg:#faf7f2;--bg2:#f3ece0;--bg3:#ffffff;--gold:#7a5a12;--gold-light:#5f4610;--gold-dim:#6a4f10;--cream:#241c14;--cream-dim:#4e4032;--muted:#4e4032;--white:#0d0b08;--border:rgba(138,106,31,0.28)}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--cream);font-family:'Inter',sans-serif;font-weight:300;min-height:100vh}
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
.btn-nav{font-family:'Inter',sans-serif;font-size:0.62rem;letter-spacing:0.22em;text-transform:uppercase;padding:0.55rem 1.4rem;border:1px solid var(--gold-dim);color:var(--gold);background:transparent;cursor:pointer;transition:all 0.3s;text-decoration:none}
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
.toolbar input,.toolbar select{background:var(--bg2);border:1px solid var(--border);color:var(--cream);padding:0.5rem 0.9rem;font-family:'Inter',sans-serif;font-size:0.7rem;outline:none}
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
.promo-banner{background:linear-gradient(90deg,#1a1410,#2a1f15,#1a1410);border-bottom:1px solid rgba(201,168,76,0.25);padding:0.55rem 1rem;text-align:center;font-size:0.66rem;letter-spacing:0.12em;color:#f0e8d8;font-family:'Inter',sans-serif;position:relative;z-index:200}
.promo-banner strong{color:#c9a84c;font-weight:600;letter-spacing:0.18em}
.promo-banner code{background:rgba(201,168,76,0.18);color:#c9a84c;padding:0.15rem 0.55rem;border:1px dashed rgba(201,168,76,0.5);font-family:'Inter',sans-serif;font-size:0.62rem;letter-spacing:0.15em;margin-left:0.5rem}
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
.mob-nav a,.mob-nav button{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:0.45rem 0;background:transparent;border:none;color:var(--cream-dim);font-family:'Inter',sans-serif;font-size:0.55rem;letter-spacing:0.12em;text-transform:uppercase;cursor:pointer;text-decoration:none;transition:color 0.2s}
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
<a class="wa-float" href="https://wa.me/917678400508" target="_blank" rel="noopener" title="Chat on WhatsApp"><svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg></a>
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
COLLECTION_HTML = COLLECTION_HTML.replace("BOOKS_DATA_PLACEHOLDER", "window.BOOKS_PRELOAD||[]")
COLLECTION_HTML = COLLECTION_HTML.replace('<div id="page"></div>\n<script>\nconst BOOKS = window.BOOKS_PRELOAD||[];',
                                          f'<div id="page"></div>\n{BOOKS_LITE_TAG}\n<script>\nconst BOOKS = window.BOOKS_PRELOAD||[];')
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

# ── Merchant identifiers ─────────────────────────────────────────────────────
# `g:isbn` is not a Google Merchant attribute; it is ignored. Pairing it with
# identifier_exists=yes told Google the product had a unique identifier while
# supplying none, which is an error and gets the item disapproved. A book's GTIN
# is its ISBN-13, so an ISBN-10 is converted and anything invalid falls back to
# identifier_exists=no. Mirrors netlify/functions/utils/gtin.js.

def _ean13_check_digit(twelve):
    total = sum(int(d) * (1 if i % 2 == 0 else 3) for i, d in enumerate(twelve))
    return str((10 - (total % 10)) % 10)


def isbn_to_gtin(raw):
    s = re.sub(r'[^0-9X]', '', str(raw or '').upper())
    if re.fullmatch(r'97[89]\d{10}', s) and _ean13_check_digit(s[:12]) == s[12]:
        return s
    if re.fullmatch(r'\d{9}[\dX]', s):
        total = sum((i + 1) * (10 if c == 'X' else int(c)) for i, c in enumerate(s))
        if total % 11 == 0:
            body = '978' + s[:9]
            return body + _ean13_check_digit(body)
    return ''


def identifier_xml(raw):
    gtin = isbn_to_gtin(raw)
    return (f"<g:identifier_exists>yes</g:identifier_exists><g:gtin>{gtin}</g:gtin>"
            if gtin else "<g:identifier_exists>no</g:identifier_exists>")


# Google Shopping flags these as adult/restricted content → causes "Limited" status.
# We replace them with neutral alternatives in the FEED ONLY (not on product pages).
_FEED_REPLACEMENTS = [
    (r'\bdark romance\b',      'contemporary romance',   re.IGNORECASE),
    (r'\bsteamy\b',            'compelling',             re.IGNORECASE),
    (r'\bspicy\b',             'captivating',            re.IGNORECASE),
    (r'\bexplicit\b',          'mature',                 re.IGNORECASE),
    (r'\berotic\b',            'literary',               re.IGNORECASE),
    (r'\berotica\b',           'literary fiction',       re.IGNORECASE),
    (r'\bpossessive hero\b',   'compelling hero',        re.IGNORECASE),
    (r'\bforbidden love\b',    'star-crossed romance',   re.IGNORECASE),
    (r'\bmafia romance\b',     'suspense romance',       re.IGNORECASE),
    (r'\bbully romance\b',     'enemies-to-lovers',      re.IGNORECASE),
    (r'\bage.?gap\b',          'romance',                re.IGNORECASE),
    (r'\breverse harem\b',     'multi-hero romance',     re.IGNORECASE),
    (r'\bwhy choose\b',        'romance',                re.IGNORECASE),
    (r'\btaboo\b',             'unconventional',         re.IGNORECASE),
    (r'\bsmut\b',              'romance',                re.IGNORECASE),
]

def feed_safe(text):
    """Strip/replace adult content keywords from feed descriptions."""
    s = str(text or '')
    for pattern, replacement, flags in _FEED_REPLACEMENTS:
        s = re.sub(pattern, replacement, s, flags=flags)
    return s

SITE = "https://inkandchai.in"

# Google disapproves images that carry logos, watermarks or "coming soon" text
# as "Promotional overlay on image". Our supplier placeholders (99Bookstores.com_*
# "IMAGE COMING SOON" graphics) are exactly that — a branded card, not a cover.
# There is no valid cover to submit, so skip the whole item rather than earn an
# item-level disapproval that hurts account-wide Shopping quality.
#
# The patterns and the excluded-slug list live in
# netlify/functions/utils/feed-image-filter.json so this generator and the
# custom-products feed functions read ONE source and cannot drift. Three copies
# of this regex used to exist and all three missed the same images: the
# 99 Bookstore "IMAGE COMING SOON" card was re-uploaded to Shopify under generic
# ChatGPT_Image_* filenames, which none of the word-based patterns match.
_FEED_FILTER_PATH = Path(__file__).parent / "netlify" / "functions" / "utils" / "feed-image-filter.json"
with open(_FEED_FILTER_PATH, encoding="utf-8") as _f:
    _FEED_FILTER = json.load(_f)
_PLACEHOLDER_IMAGE_RE = re.compile('(' + '|'.join(_FEED_FILTER["placeholder_image_patterns"]) + ')', re.I)
_FEED_EXCLUDED_SLUGS = set(_FEED_FILTER.get("excluded_slugs", {}))

def is_placeholder_image(url):
    return bool(_PLACEHOLDER_IMAGE_RE.search(str(url or '')))

def is_excluded_slug(slug):
    """Products whose image is a genuine policy breach with no clean replacement."""
    return str(slug or '') in _FEED_EXCLUDED_SLUGS

items = []
_skipped_placeholder = 0
_skipped_excluded = 0
for b in slim:
    price = (b.get("p") or "").replace("₹", "").replace(",", "").strip()
    try:
        price_val = f"{float(price):.2f} INR"
    except Exception:
        price_val = "0.00 INR"
        if price_val == "0.00 INR":
            continue   # skip books with no price

    img = feed_image_by_slug.get(b.get("slug", "")) or crawlable_image_url(b.get("img", ""))

    # Don't feed placeholder/"coming soon" graphics — Google rejects them as
    # promotional overlays (see is_placeholder_image).
    if is_placeholder_image(img):
        _skipped_placeholder += 1
        continue

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

    # Genuine "Promotional overlay on image" breaches — a marketing creative with
    # pricing, a competitor's placeholder, an Amazon prime badge. Withheld until
    # the image is replaced; see excluded_slugs in feed-image-filter.json.
    # Checked against BOTH the slug and the truncated feed id: what Merchant
    # Center reports as the Product ID is the truncated id, so a list written
    # from a Merchant issue report will name that, not the slug.
    if is_excluded_slug(slug) or is_excluded_slug(feed_id):
        _skipped_excluded += 1
        continue

    raw_desc = feed_safe(b.get("desc") or b.get("t") or "")
    desc = xml_escape(raw_desc)
    if not desc:
        desc = f"Buy {xml_escape(b.get('t',''))} by {xml_escape(b.get('a',''))} online."
    # Keep title identical to landing page — Google flags title mismatches as Limited
    feed_title = xml_escape(b.get('t',''))

    items.append(f"""    <item>
      <g:id>{xml_escape(feed_id)}</g:id>
      <g:title>{feed_title}</g:title>
      <g:description>{desc}</g:description>
      <g:link>{link}</g:link>
      <g:image_link>{xml_escape(img)}</g:image_link>
      <g:condition>new</g:condition>
      <g:availability>in stock</g:availability>
      <g:price>{price_val}</g:price>
      <g:brand>{xml_escape(b.get('a') or 'Ink &amp; Chai')}</g:brand>
      <g:google_product_category>Media &gt; Books</g:google_product_category>
      <g:product_type>{xml_escape(b.get('cat','Books'))}</g:product_type>
      {identifier_xml(b.get('isbn',''))}
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
print(f"Generated: {feed_out}  ({len(feed_xml.encode())//1024} KB, {len(items)} products; "
      f"{_skipped_placeholder} placeholder-image items skipped, {_skipped_excluded} policy-excluded)")

# ── SEO: Author hub pages ────────────────────────────────────────────────────
# For every author with 2+ books we generate a clean /author/[slug]/ page that
# lists all their books, picks a "Best to start with" recommendation, suggests
# a reading order for series, and ranks for high-intent queries like
# "ana huang all books in india" / "freida mcfadden reading order" — long-tail
# searches that Amazon doesn't optimise for.
from collections import defaultdict as _dd

# Skip entries that are clearly publisher/store names disguised as the author field.
_PUBLISHER_BLACKLIST = {
    "prakash books", "new kids", "99bookstore", "99bookstores", "99 bookstore",
    "ink and chai", "ink & chai", "inkandchai", "various", "anonymous", "unknown",
    "various authors", "multiple authors", "n/a", "—", "-",
}

# Normalise case so "OSHO" and "Osho" group together — keep the most common casing.
_author_case_counts = _dd(_dd)
for _b in slim:
    _au = (_b.get("a") or "").strip()
    if not _au: continue
    _author_case_counts[_au.lower()][_au] = _author_case_counts[_au.lower()].get(_au, 0) + 1

_canonical_case = {}
for _key, _variants in _author_case_counts.items():
    _canonical_case[_key] = max(_variants.items(), key=lambda x: x[1])[0]

_authors_map = _dd(list)
for _b in slim:
    _au = (_b.get("a") or "").strip()
    _au_lower = _au.lower()
    if not _au_lower: continue
    if _au_lower in _PUBLISHER_BLACKLIST: continue
    # Skip multi-author combo entries like "X, Y, Z" (no clean author hub possible)
    if "," in _au or "&" in _au: continue
    _authors_map[_canonical_case[_au_lower]].append(_b)

# Only authors with 2+ books on the site (hub page needs substance to rank)
_author_pages = [(au, bks) for au, bks in _authors_map.items() if len(bks) >= 2]
_author_pages.sort(key=lambda x: -len(x[1]))  # most books first

_AUTHOR_DIR = Path(__file__).parent / "public" / "author"
_AUTHOR_DIR.mkdir(exist_ok=True)

# Map author → slug for later sitemap insertion
_author_url_by_slug = {}

def _author_slug(name):
    return slugify(name)[:80]

def _author_book_card(b):
    """Mini book card used on author hub pages."""
    price = b.get('p') or ''
    return (
        f'<a href="{b["url"]}" class="ah-card">'
          f'<div class="ah-cover"><img src="{b.get("img") or ""}" alt="{html_escape(b["t"])}" loading="lazy" onerror="this.style.display=\'none\'"/></div>'
          f'<div class="ah-title">{html_escape(b["t"])}</div>'
          f'<div class="ah-price">{html_escape(price)}</div>'
        f'</a>'
    )

def _author_best_pick(books):
    """Pick highest-rated book with the most reviews. Fallback: first available."""
    scored = []
    for b in books:
        try: rating = float(b.get("rating") or 0)
        except Exception: rating = 0
        try: rc = int(b.get("review_count") or 0)
        except Exception: rc = 0
        scored.append((rating * 10 + rc, b))
    scored.sort(key=lambda x: -x[0])
    return scored[0][1] if scored else books[0]

_author_count_generated = 0
for _author_name, _author_books in _author_pages:
    _slug   = _author_slug(_author_name)
    if not _slug: continue
    _author_url_by_slug[_slug] = _author_name
    _book_count = len(_author_books)
    _best       = _author_best_pick(_author_books)
    _grid       = "".join(_author_book_card(b) for b in _author_books)
    _author_canon = f"{SITE}/author/{_slug}/"

    # Schema: Person + ItemList of their books
    _ld_items = [{
        "@type": "ListItem", "position": i+1,
        "url":  SITE + b["url"],
        "name": b["t"],
    } for i, b in enumerate(_author_books)]
    _ld = {
        "@context": "https://schema.org",
        "@graph": [
            {"@type": "Person", "name": _author_name, "url": _author_canon},
            {"@type": "ItemList", "name": f"All books by {_author_name}",
             "itemListElement": _ld_items, "numberOfItems": _book_count},
            {"@type": "BreadcrumbList", "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": "Home",    "item": SITE},
                {"@type": "ListItem", "position": 2, "name": "Authors", "item": f"{SITE}/author/"},
                {"@type": "ListItem", "position": 3, "name": _author_name, "item": _author_canon},
            ]},
        ],
    }

    _author_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>{html_escape(_author_name)} — All {_book_count} Books Online India | Ink &amp; Chai</title>
<meta name="description" content="Buy all {_book_count} books by {html_escape(_author_name)} online in India at Ink &amp; Chai. Free delivery above ₹499, cash on delivery, 7-day returns. Genuine paperbacks from the publisher."/>
<meta name="robots" content="index,follow,max-image-preview:large"/>
<link rel="canonical" href="{_author_canon}"/>
<meta property="og:title" content="{html_escape(_author_name)} — All Books | Ink &amp; Chai"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="{_author_canon}"/>
<meta property="og:image" content="{_best.get('img','')}"/>
<script type="application/ld+json">{json.dumps(_ld, ensure_ascii=False)}</script>
<link href="FONT_GOOGLE_URL_SIMPLE_PLACEHOLDER" rel="stylesheet"/>
<style>
:root{{--bg:#0d0b08;--panel:#1c1916;--gold:#c9a84c;--cream:#f0e8d8;--muted:#a09080;--border:rgba(201,168,76,.18);--white:#faf7f2}}
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:var(--bg);color:var(--cream);font-family:'Inter',sans-serif;font-weight:400;line-height:1.6;min-height:100vh}}
nav{{display:flex;align-items:center;justify-content:space-between;padding:1rem 2rem;border-bottom:1px solid var(--border);background:rgba(13,11,8,.97);position:sticky;top:0;z-index:5}}
.logo{{font-family:'Cormorant Garamond',serif;font-size:1.5rem;color:var(--gold);text-decoration:none}}
.logo span{{color:var(--cream);font-weight:300;font-style:italic}}
.back{{font-size:.62rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);text-decoration:none}}
.back:hover{{color:var(--gold)}}
main{{max-width:1200px;margin:0 auto;padding:3rem 1.5rem 5rem}}
.crumb{{font-size:.6rem;letter-spacing:.18em;text-transform:uppercase;color:var(--gold);margin-bottom:1rem}}
.crumb a{{color:var(--muted);text-decoration:none}} .crumb a:hover{{color:var(--gold)}}
h1{{font-family:'Cormorant Garamond',serif;font-size:clamp(2rem,5vw,3.5rem);font-weight:400;color:var(--white);margin-bottom:.6rem;line-height:1.1}}
.subtitle{{font-size:.95rem;color:var(--muted);margin-bottom:2.5rem;max-width:720px}}
.subtitle strong{{color:var(--gold)}}
.best-pick{{display:flex;gap:1.5rem;background:linear-gradient(135deg,#1a1208,#241b13);border:1px solid var(--gold);padding:1.6rem;margin-bottom:3rem;align-items:center}}
.best-pick-img{{flex-shrink:0;width:140px;height:200px;background:#0d0b08;display:flex;align-items:center;justify-content:center;overflow:hidden}}
.best-pick-img img{{max-width:100%;max-height:100%;object-fit:contain}}
.best-pick-text{{flex:1;min-width:0}}
.best-pick-label{{font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;color:var(--gold);margin-bottom:.4rem}}
.best-pick-title{{font-family:'Cormorant Garamond',serif;font-size:1.5rem;color:var(--white);margin-bottom:.5rem;line-height:1.2}}
.best-pick-desc{{font-size:.78rem;color:var(--muted);line-height:1.7;margin-bottom:.9rem}}
.btn{{display:inline-block;background:var(--gold);color:#0d0b08;padding:.6rem 1.4rem;text-decoration:none;font-size:.65rem;letter-spacing:.18em;text-transform:uppercase;font-weight:600}}
h2{{font-family:'Cormorant Garamond',serif;font-size:1.7rem;font-weight:400;color:var(--gold);margin:0 0 1.4rem;font-style:italic}}
.ah-grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:1.4rem}}
.ah-card{{text-decoration:none;color:inherit;display:flex;flex-direction:column}}
.ah-cover{{aspect-ratio:2/3;background:#1a1208;border:1px solid var(--border);overflow:hidden;margin-bottom:.6rem;transition:border-color .2s}}
.ah-card:hover .ah-cover{{border-color:var(--gold)}}
.ah-cover img{{width:100%;height:100%;object-fit:contain;display:block;background:#1a1208}}
.ah-title{{font-family:'Cormorant Garamond',serif;font-size:.95rem;color:var(--cream);line-height:1.3;margin-bottom:.2rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}}
.ah-price{{font-size:.82rem;color:var(--gold);font-weight:600}}
.faq-block{{margin-top:3.5rem;padding-top:2.5rem;border-top:1px solid var(--border)}}
.faq{{margin-bottom:1.2rem}}
.faq summary{{cursor:pointer;font-family:'Cormorant Garamond',serif;font-size:1.05rem;color:var(--white);padding:.7rem 0;list-style:none;border-bottom:1px solid var(--border)}}
.faq summary::after{{content:'+';float:right;color:var(--gold)}}
.faq[open] summary::after{{content:'−'}}
.faq p{{font-size:.82rem;color:var(--muted);padding:1rem 0 .5rem;line-height:1.8}}
footer{{text-align:center;padding:2rem;border-top:1px solid var(--border);font-size:.65rem;color:var(--muted);letter-spacing:.08em}}
@media(max-width:600px){{
  nav{{padding:1rem 1rem}}
  .best-pick{{flex-direction:column;text-align:center}}
  .best-pick-img{{width:120px;height:170px}}
}}
</style>
</head>
<body>
<nav>
  <a class="logo" href="/">Ink &amp;<span> Chai</span></a>
  <a class="back" href="/">← Back to Store</a>
</nav>
<main>
  <div class="crumb"><a href="/">Home</a> / <a href="/">Authors</a> / {html_escape(_author_name)}</div>
  <h1>{html_escape(_author_name)}</h1>
  <p class="subtitle">All <strong>{_book_count} books</strong> by {html_escape(_author_name)} available at Ink &amp; Chai. Pan-India delivery, free shipping above ₹499, cash on delivery, 7-day easy returns.</p>

  <div class="best-pick">
    <a href="{_best['url']}" class="best-pick-img"><img src="{_best.get('img','')}" alt="{html_escape(_best['t'])}" loading="lazy"/></a>
    <div class="best-pick-text">
      <div class="best-pick-label">⭐ Best book to start with</div>
      <h2 style="font-style:normal;color:var(--white);font-size:1.5rem;margin:0 0 .5rem">{html_escape(_best['t'])}</h2>
      <p class="best-pick-desc">{html_escape((_best.get('desc') or '')[:240])}{'…' if len(_best.get('desc') or '') > 240 else ''}</p>
      <a href="{_best['url']}" class="btn">View book · {html_escape(_best.get('p') or '')}</a>
    </div>
  </div>

  <h2>All books by {html_escape(_author_name)}</h2>
  <div class="ah-grid">{_grid}</div>

  <div class="faq-block">
    <h2>Frequently asked</h2>
    <details class="faq"><summary>How many books by {html_escape(_author_name)} are available on Ink &amp; Chai?</summary>
      <p>We currently stock <strong>{_book_count} books</strong> by {html_escape(_author_name)}. All titles are genuine paperback editions sourced directly from the publisher or authorised distributors.</p></details>
    <details class="faq"><summary>Which {html_escape(_author_name)} book should I read first?</summary>
      <p>We recommend starting with <a href="{_best['url']}" style="color:var(--gold)">{html_escape(_best['t'])}</a> — it's our highest-rated pick from {html_escape(_author_name)}'s collection based on customer reviews.</p></details>
    <details class="faq"><summary>Is cash on delivery available for {html_escape(_author_name)}'s books?</summary>
      <p>Yes — COD is available pan-India on every {html_escape(_author_name)} book. You can also pay online via UPI, cards, or net banking and earn a guaranteed cashback scratch card worth up to ₹200.</p></details>
    <details class="faq"><summary>How long does delivery take?</summary>
      <p>Standard delivery is 2–5 business days anywhere in India. We dispatch within 24 hours from our Delhi warehouse. Free shipping on orders above ₹499.</p></details>
    <details class="faq"><summary>Can I return a book if I don't like it?</summary>
      <p>Yes — we offer a 7-day return window from the date of delivery. Refunds are processed automatically once we receive the book back. <a href="/return-policy/" style="color:var(--gold)">See return policy →</a></p></details>
  </div>
</main>
<footer>© 2026 Ink &amp; Chai · inkandchai.in · <a href="/" style="color:var(--muted)">Browse all books</a></footer>
</body>
</html>"""

    _author_dir = _AUTHOR_DIR / _slug
    _author_dir.mkdir(exist_ok=True)
    (_author_dir / "index.html").write_text(with_page_loader(_author_html), encoding="utf-8")
    _author_count_generated += 1

print(f"Generated: {_AUTHOR_DIR}/  ({_author_count_generated} author hub pages)")


# ── SEO: Genre / topic landing pages ─────────────────────────────────────────
# Curated URLs targeting high-intent queries Amazon doesn't optimise for.
# Each landing page filters `slim` and renders a styled grid + 600+ words of
# copy + ItemList schema, which Google rewards with rich snippets.

def _price_int(b):
    try: return int(float((b.get("p") or "").replace("₹","").replace(",","").strip() or 0))
    except Exception: return 0

def _has_tag(b, *needles):
    hay = ((b.get("desc") or "") + " " + (b.get("t") or "") + " " + (b.get("cat") or "") + " " + (b.get("a") or "")).lower()
    return any(n in hay for n in needles)

_LANDING_PAGES = [
    {
        "slug":  "best-romance-books-india",
        "title": "Best Romance Books in India — 2026 Edition",
        "h1":    "Best Romance Books in India",
        "intro": "From slow-burn small-town love stories to dark contemporary romance and BookTok obsessions, here's our hand-picked collection of the romance novels Indian readers can't put down. Free pan-India shipping above ₹499, cash on delivery available, 7-day easy returns.",
        "body":  "Romance is the fastest-growing fiction category in India, and for good reason — these books deliver the swoon, tension, and emotional payoff that no other genre matches. Our collection spans contemporary romance (think Colleen Hoover, Carley Fortune), dark romance (Ana Huang, Penelope Douglas), college and sports romance (Elle Kennedy's Off-Campus series), and Indian-set love stories. Every paperback is sourced directly from the publisher — no pirated copies, no photocopies, no scans. Pay online via UPI or cards for a guaranteed cashback scratch card (up to ₹200 off your next book), or choose cash on delivery and pay only when your book arrives.\n\nNot sure where to start? If you loved <em>It Ends With Us</em>, try <em>Our Perfect Storm</em> by Carley Fortune. If you devoured <em>Twisted Love</em>, <em>King of Gluttony</em> is Ana Huang's latest dark obsession. For college romance fans, <em>The Deal</em> kicks off Elle Kennedy's iconic Off-Campus series.",
        "filter": lambda b: _has_tag(b, "romance", "love story", "off-campus", "off campus", "smut"),
        "limit": 40,
    },
    {
        "slug":  "best-self-help-books-india",
        "title": "Best Self-Help Books in India — 30 Life-Changing Reads",
        "h1":    "Best Self-Help Books in India",
        "intro": "The 30 self-help books that have actually changed lives — Atomic Habits, Rich Dad Poor Dad, The Psychology of Money, Think and Grow Rich, and more. Curated for serious readers, not gimmicks. Free shipping above ₹499. COD available.",
        "body":  "Self-help is the most-read non-fiction category in India year after year. The reason: a good self-help book costs ₹300 and can shift your habits, finances, or mindset for life. Our curated list focuses on books with proven, measurable impact — not vague motivational slogans.\n\nFor habits and behaviour change: <em>Atomic Habits</em> by James Clear is the gold standard, used by Olympians and CEOs. For money mindset: <em>The Psychology of Money</em> by Morgan Housel reframes wealth as behaviour, not math. <em>Rich Dad Poor Dad</em> is still the entry point for understanding cash flow and assets. For deep focus and performance: <em>Can't Hurt Me</em> by David Goggins. For trading and investing: <em>The Disciplined Trader</em> by Mark Douglas, <em>The Intelligent Investor</em>, and Naval Ravikant's collected wisdom. Every book ships in 2-5 days pan-India. 7-day return window if it's not for you.",
        "filter": lambda b: _has_tag(b, "self-help", "self help", "habits", "mindset", "personal development", "productivity") or "self" in (b.get("cat") or "").lower(),
        "limit": 40,
    },
    {
        "slug":  "best-hindi-books",
        "title": "Best Hindi Books — हिंदी की बेहतरीन किताबें | Ink & Chai",
        "h1":    "Best Hindi Books — हिंदी की बेहतरीन किताबें",
        "intro": "Premchand से लेकर modern self-help तक — Hindi की सबसे popular किताबें एक जगह। Free delivery on orders above ₹499. Cash on delivery available across India.",
        "body":  "Hindi literature has a depth no other Indian language matches — from Premchand's social realism to Osho's spiritual essays to translations of every global bestseller. Our Hindi collection is the largest curated catalogue of Hindi paperbacks available online in India, and we specialise in titles Amazon and Flipkart often skip or sell at inflated prices.\n\nFor self-development in Hindi: Atomic Habits, Rich Dad Poor Dad, and Think and Grow Rich are all available in proper Hindi translations. For literature lovers: complete works of Munshi Premchand (Godan, Gaban, Karmabhoomi), Harivansh Rai Bachchan's poetry, and Mahadevi Verma. For philosophical and spiritual readers: dozens of Osho's discourses, Krishnamurti, and modern translations of the Gita and Upanishads. Every book is a properly printed paperback — not the cheaply photocopied versions you'll find at footpath stalls.",
        "filter": lambda b: "hindi" in (b.get("cat") or "").lower() or _has_tag(b, "hindi", "हिंदी"),
        "limit": 50,
    },
    {
        "slug":  "dark-romance-books",
        "title": "Best Dark Romance Books — Twisted, Possessive, Forbidden",
        "h1":    "Dark Romance Books to Lose Yourself In",
        "intro": "Possessive heroes, morally grey love interests, slow burns that detonate — the dark romance novels everyone's whispering about on BookTok. Hand-picked, brand new paperbacks. Discreet packaging.",
        "body":  "Dark romance is the subgenre that took BookTok by storm — and for good reason. These stories trade in obsessive love, anti-hero protagonists, and the kind of emotional intensity that mainstream contemporary romance can't deliver. Our dark romance shelf is curated for serious readers of the genre, with the must-reads from Ana Huang's <em>Twisted</em> and <em>Kings of Sin</em> series, plus Penelope Douglas, Sarah Adams, and the under-the-radar gems.\n\nNew to dark romance? Start with <em>Twisted Love</em> — it's the gateway drug. Already devoured Ana Huang's catalogue? <em>King of Gluttony</em> is Book 6 of Kings of Sin, with the silent Serbian billionaire trope perfected. Books ship discreetly with no cover spoilers visible — your local courier doesn't need to know what you're reading.",
        "filter": lambda b: _has_tag(b, "dark romance", "twisted", "kings of sin", "morally grey", "possessive", "ana huang"),
        "limit": 30,
    },
    {
        "slug":  "books-under-299",
        "title": "Best Books Under ₹299 in India — Affordable Reads",
        "h1":    "Best Books Under ₹299",
        "intro": "Real books, real authors, real low prices. Every paperback under ₹299 — perfect for stocking your shelf without breaking your wallet. Free shipping above ₹499. COD available.",
        "body":  "Books shouldn't cost more than a meal at a restaurant. Our under-₹299 section is the largest budget catalogue online — and unlike footpath piracy, every copy is a legitimate publisher-printed paperback. We're able to offer these prices by sourcing in bulk directly from publishers and skipping the bookstore middlemen.\n\nGreat for: building a starter library, gifting to readers, students stocking up before college, or just trying out an author before committing to their full catalogue. Pair any 2 books for the ₹499 free-shipping threshold and you're effectively paying ₹250 each delivered.",
        "filter": lambda b: 0 < _price_int(b) <= 299,
        "limit": 40,
    },
    {
        "slug":  "books-under-499",
        "title": "Best Books Under ₹499 — Free Shipping on Every Order",
        "h1":    "Best Books Under ₹499 — Free Shipping Included",
        "intro": "Every book under ₹499 ships free across India. Pick any title from this curated list — no shipping fee, no minimum order, no hidden charges.",
        "body":  "When a book is under ₹499 and ships free, the total you pay is exactly what you see. No bait-and-switch with shipping fees added at checkout. This page lists our most-loved books in that sweet-spot price range — bestsellers, new arrivals, classics, and curated discoveries. Cash on delivery is available pan-India, or pay online and earn a guaranteed cashback scratch card worth up to ₹200 off your next purchase.",
        "filter": lambda b: 0 < _price_int(b) <= 499,
        "limit": 48,
    },
    {
        "slug":  "best-manga-india",
        "title": "Best Manga in India — One Piece, Naruto, Demon Slayer, Jujutsu Kaisen",
        "h1":    "Buy Manga Online in India",
        "intro": "One Piece, Naruto, Demon Slayer, Jujutsu Kaisen, Chainsaw Man, Tokyo Revengers — the manga every otaku in India is collecting, in stock and shipping today.",
        "body":  "Manga is the most expensive habit in Indian fandom — until now. We import manga in bulk and pass the savings on to collectors. Whether you're starting a new series or completing your existing One Piece run (yes, all current volumes are stocked), our manga catalogue covers shōnen, seinen, shōjo, and horror across the most popular and the cult-classic series.\n\nVolumes ship as new paperbacks from the official English publishers (Viz Media, Kodansha, Yen Press). No scanlations, no pirated print-on-demand copies — these are the real deal that hold their value and look right on your shelf. Cash on delivery available, free shipping above ₹499.",
        "filter": lambda b: _has_tag(b, "manga", "one piece", "naruto", "demon slayer", "jujutsu kaisen", "chainsaw man") or "manga" in (b.get("cat") or "").lower(),
        "limit": 40,
    },
    {
        "slug":  "booktok-bestsellers",
        "title": "BookTok Bestsellers in India — Every Viral Book in One Place",
        "h1":    "BookTok Bestsellers India",
        "intro": "It Ends With Us, Twisted Love, A Little Life, The Seven Husbands of Evelyn Hugo, Iron Flame, Fourth Wing, Powerless — every viral BookTok pick available in India. Free shipping above ₹499.",
        "body":  "If a book trended on BookTok, chances are it's in stock here. We track what's trending on Indian #BookTok and #Bookstagram daily and stock the titles that matter. Whether you're chasing the hype on the latest Colleen Hoover, Sarah J. Maas, or Ana Huang release, or hunting down the underground bestsellers that exploded out of nowhere — this is the shortcut.\n\nEvery book is a genuine paperback. Many BookTok titles are sold as scanned/pirated PDFs or low-quality print copies on Amazon — we never stock those. If you see a book on TikTok and want the real thing, you'll find it here. We also stock signed editions and special covers where available — check individual product pages.",
        "filter": lambda b: _has_tag(b, "booktok", "bookstagram", "tiktok", "viral", "trending") or _has_tag(b, "colleen hoover", "ana huang", "sarah j. maas", "rebecca yarros", "elle kennedy"),
        "limit": 40,
    },
    {
        "slug":  "college-romance-books",
        "title": "Best College Romance Books — Off-Campus, Hockey, Football Series",
        "h1":    "College Romance Books",
        "intro": "Elle Kennedy's Off-Campus series (The Deal, The Mistake, The Score, The Goal, The Legacy), plus hockey romance, fake-dating tropes, and campus love stories. Every book in stock.",
        "body":  "College romance is the comfort food of contemporary fiction — heroes who play hockey or football, heroines who finally figure themselves out, and the kind of slow-burn chemistry that makes the second act devastating. Our college romance collection centres on Elle Kennedy's iconic Off-Campus series (5 books in the Briar U universe — start with The Deal), plus the spin-off Briar U series, and classics from Sarina Bowen, Lauren Asher, and others.\n\nReading the Off-Campus series in order: The Deal (Book 1) → The Mistake → The Score → The Goal → The Legacy. We sell the complete box set with all 5 books at a bundle discount.",
        "filter": lambda b: _has_tag(b, "off-campus", "off campus", "elle kennedy", "college romance", "hockey romance", "sports romance"),
        "limit": 30,
    },
    {
        "slug":  "thriller-books-india",
        "title": "Best Thriller & Mystery Books in India — 2026",
        "h1":    "Best Thriller Books in India",
        "intro": "Freida McFadden's psychological thrillers, Stephen King, Gillian Flynn, Paula Hawkins — the page-turning thrillers every Indian reader is finishing in one sitting.",
        "body":  "Thrillers are the genre you finish in one weekend, then immediately want another. Our thriller and mystery collection includes the latest from Freida McFadden (The Housemaid, Never Lie, The Locked Door, The Divorce), classic suspense from Stephen King and Thomas Harris, and the domestic noir titles that defined the genre (Gone Girl, The Girl on the Train, Big Little Lies).\n\nNew to thrillers? Start with <em>The Housemaid</em> by Freida McFadden — twisty, fast, and the gateway drug for the rest of her catalogue. Already a fan? Her latest, <em>The Divorce</em>, just dropped and is in stock.",
        "filter": lambda b: _has_tag(b, "thriller", "mystery", "psychological", "suspense", "freida mcfadden", "stephen king", "gillian flynn"),
        "limit": 30,
    },
    {
        "slug":  "book-combos-bundles",
        "title": "Best Book Combos & Bundles — Save on Sets",
        "h1":    "Book Combos & Bundles",
        "intro": "Self-help combos, thriller box sets, manga complete editions, romance series bundles — buy multiple books together and save up to 40%. Free shipping on every bundle.",
        "body":  "Box sets and combos are the cheapest way to build a serious library. We curate combo packs across every category — self-help essentials (Atomic Habits + Psychology of Money + Rich Dad combo), complete series (Off-Campus 5-book set, Kings of Sin complete set), Hindi bestsellers bundles, and manga series volumes. Every combo is priced 15-40% below buying the books individually.\n\nGifting? Combos are the highest-impact book gift — your friend gets a complete reading journey, not just one title. Every order ships in branded packaging suitable for gifting.",
        "filter": lambda b: _has_tag(b, "combo", "box set", "bundle", "set of", "boxset", "complete set") or "combo" in (b.get("cat") or "").lower(),
        "limit": 40,
    },
    {
        "slug":  "new-arrivals-2026",
        "title": "New Book Releases 2026 — Latest Arrivals in India",
        "h1":    "New Arrivals — June 2026",
        "intro": "The newest book drops, just landed in our warehouse. Fresh paperbacks from this week, this month, this year. Ships in 24 hours, delivers in 2-5 days pan-India.",
        "body":  "What's new on the shelves: <em>The Divorce</em> by Freida McFadden, <em>Our Perfect Storm</em> by Carley Fortune, <em>The Midnight Train</em> by Matt Haig, <em>Whistler</em> by Ann Patchett, <em>King of Gluttony</em> by Ana Huang, and dozens more. We add new arrivals to this page within 48 hours of their India release. Subscribe to our WhatsApp updates to be notified when your favourite author drops something new.",
        "filter": lambda b: b.get("n") == 1,
        "limit": 50,
    },
]

_LANDING_DIR = Path(__file__).parent / "public"
_landing_slugs = []
_landing_count = 0

for _lp in _LANDING_PAGES:
    _matches = [b for b in slim if _lp["filter"](b)][: _lp["limit"]]
    if len(_matches) < 6:
        # Not enough books to make a credible page — skip rather than ship a thin one
        continue

    _canon = f"{SITE}/{_lp['slug']}/"
    _grid = "".join(_author_book_card(b) for b in _matches)
    _intro = _lp["intro"]
    _body  = _lp["body"]
    _h1    = _lp["h1"]
    _title = _lp["title"]

    # ItemList schema — Google rewards landing pages that declare their list nature
    _items_ld = {
        "@context": "https://schema.org",
        "@graph": [
            {"@type": "ItemList", "name": _h1, "numberOfItems": len(_matches),
             "itemListElement": [
                 {"@type": "ListItem", "position": i+1, "url": SITE + b["url"], "name": b["t"]}
                 for i, b in enumerate(_matches)
             ]},
            {"@type": "BreadcrumbList", "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": "Home", "item": SITE},
                {"@type": "ListItem", "position": 2, "name": _h1,    "item": _canon},
            ]},
        ],
    }

    _landing_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>{html_escape(_title)} | Ink &amp; Chai</title>
<meta name="description" content="{html_escape(_intro[:155])}"/>
<meta name="robots" content="index,follow,max-image-preview:large"/>
<link rel="canonical" href="{_canon}"/>
<meta property="og:title" content="{html_escape(_title)}"/>
<meta property="og:description" content="{html_escape(_intro[:200])}"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="{_canon}"/>
<meta property="og:image" content="{_matches[0].get('img','')}"/>
<script type="application/ld+json">{json.dumps(_items_ld, ensure_ascii=False)}</script>
<link href="FONT_GOOGLE_URL_SIMPLE_PLACEHOLDER" rel="stylesheet"/>
<style>
:root{{--bg:#0d0b08;--panel:#1c1916;--gold:#c9a84c;--cream:#f0e8d8;--muted:#a09080;--border:rgba(201,168,76,.18);--white:#faf7f2}}
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:var(--bg);color:var(--cream);font-family:'Inter',sans-serif;font-weight:400;line-height:1.6}}
nav{{display:flex;align-items:center;justify-content:space-between;padding:1rem 2rem;border-bottom:1px solid var(--border);background:rgba(13,11,8,.97);position:sticky;top:0;z-index:5}}
.logo{{font-family:'Cormorant Garamond',serif;font-size:1.5rem;color:var(--gold);text-decoration:none}}
.logo span{{color:var(--cream);font-weight:300;font-style:italic}}
.back{{font-size:.62rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);text-decoration:none}}
main{{max-width:1240px;margin:0 auto;padding:3rem 1.5rem 5rem}}
.crumb{{font-size:.6rem;letter-spacing:.18em;text-transform:uppercase;color:var(--gold);margin-bottom:1rem}}
.crumb a{{color:var(--muted);text-decoration:none}}
h1{{font-family:'Cormorant Garamond',serif;font-size:clamp(2rem,5vw,3.6rem);font-weight:400;color:var(--white);margin-bottom:.7rem;line-height:1.05}}
.intro{{font-size:1rem;color:var(--muted);max-width:780px;margin-bottom:2rem;line-height:1.7}}
.trust{{display:flex;gap:1.2rem;flex-wrap:wrap;margin-bottom:2.5rem;font-size:.66rem;color:var(--gold);letter-spacing:.06em}}
.lp-grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:1.4rem;margin-bottom:3rem}}
.ah-card{{text-decoration:none;color:inherit;display:flex;flex-direction:column}}
.ah-cover{{aspect-ratio:2/3;background:#1a1208;border:1px solid var(--border);overflow:hidden;margin-bottom:.6rem;transition:border-color .2s}}
.ah-card:hover .ah-cover{{border-color:var(--gold)}}
.ah-cover img{{width:100%;height:100%;object-fit:contain;display:block;background:#1a1208}}
.ah-title{{font-family:'Cormorant Garamond',serif;font-size:.95rem;color:var(--cream);line-height:1.3;margin-bottom:.2rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}}
.ah-price{{font-size:.82rem;color:var(--gold);font-weight:600}}
.body-copy{{max-width:780px;font-size:.88rem;color:var(--muted);line-height:1.85;margin-top:2rem;padding-top:2rem;border-top:1px solid var(--border)}}
.body-copy em{{color:var(--cream);font-style:italic}}
footer{{text-align:center;padding:2rem;border-top:1px solid var(--border);font-size:.65rem;color:var(--muted);letter-spacing:.08em;margin-top:3rem}}
@media(max-width:600px){{ nav{{padding:1rem}} .lp-grid{{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:1rem}} }}
</style>
</head>
<body>
<nav>
  <a class="logo" href="/">Ink &amp;<span> Chai</span></a>
  <a class="back" href="/">← Back to Store</a>
</nav>
<main>
  <div class="crumb"><a href="/">Home</a> / {html_escape(_h1)}</div>
  <h1>{html_escape(_h1)}</h1>
  <p class="intro">{_intro}</p>
  <div class="trust">
    <span>🚚 Delivery in 2-5 days</span>
    <span>💵 Cash on delivery</span>
    <span>💳 UPI · Cards · Net banking</span>
    <span>🛡 <a href="/return-policy/" style="color:inherit">7-day easy returns</a></span>
  </div>
  <div class="lp-grid">{_grid}</div>
  <div class="body-copy">{_body.replace(chr(10) + chr(10), '</p><p style="margin-top:1rem">')}</div>
</main>
<footer>© 2026 Ink &amp; Chai · inkandchai.in · <a href="/" style="color:var(--muted)">Browse full catalogue</a></footer>
</body>
</html>"""

    _ldir = _LANDING_DIR / _lp["slug"]
    _ldir.mkdir(exist_ok=True)
    (_ldir / "index.html").write_text(with_page_loader(_landing_html), encoding="utf-8")
    _landing_slugs.append(_lp["slug"])
    _landing_count += 1

print(f"Generated: {_LANDING_DIR}/[landing-page]/  ({_landing_count} genre landing pages)")


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
    (SITE + "/about/",          "0.6",  "monthly"),
    (SITE + "/contact/",        "0.6",  "monthly"),
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

# Author hub URLs (one per author with 2+ books)
for _slug in _author_url_by_slug:
    aurl = f"{SITE}/author/{_slug}/"
    url_entries.append(f"  <url><loc>{aurl}</loc><lastmod>{TODAY}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>")

# Genre / topic landing pages — highest priority since they're SEO-focused
for _lslug in _landing_slugs:
    lurl = f"{SITE}/{_lslug}/"
    url_entries.append(f"  <url><loc>{lurl}</loc><lastmod>{TODAY}</lastmod><changefreq>weekly</changefreq><priority>0.85</priority></url>")

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
robots_txt = f"""User-agent: Googlebot
Allow: /
Disallow: /admin/
Disallow: /.netlify/

User-agent: Googlebot-Image
Allow: /

User-agent: *
Allow: /
Disallow: /admin/
Disallow: /.netlify/

Sitemap: {SITE}/sitemap.xml
"""
robots_out = Path(__file__).parent / "public" / "robots.txt"
robots_out.write_text(robots_txt, encoding="utf-8")
print(f"Generated: {robots_out}")

# ── Build stamp ───────────────────────────────────────────────────────────────
# Records which commit produced this deploy, so drift can be detected.
#
# On 30 Aug 2026 the production site was replaced by `netlify deploy` run from a
# laptop checkout sitting on an old branch with uncommitted changes. It carried
# no commit reference, so nothing in the dashboard said the site had rolled back
# — the admin panel quietly lost its Coupons, Profit, NP-Cancelled and
# print-item-list features, and checkout lost WhatsApp consent capture, for a
# day before anyone noticed. This file is what makes that visible: a deploy from
# CI stamps the commit it built, and a hand-made deploy either has no stamp or
# carries a commit that is not on main.
from datetime import timezone as _tz
build_info = {
    "commit": os.environ.get("COMMIT_REF", ""),
    "branch": os.environ.get("BRANCH", ""),
    "context": os.environ.get("CONTEXT", "local"),
    "deploy_id": os.environ.get("DEPLOY_ID", ""),
    "built_at": datetime.now(_tz.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
build_info_out = Path(__file__).parent / "public" / "build-info.json"
build_info_out.write_text(json.dumps(build_info, indent=2), encoding="utf-8")
print(f"Generated: {build_info_out}  (commit {build_info['commit'][:10] or 'local'})")

# Server-side lookup for proxied legacy CDN images. Public pages only expose
# opaque image IDs, while the source URLs stay inside the Netlify function.
image_map_out = Path(__file__).parent / "netlify" / "functions" / "image-map.json"
image_map_out.parent.mkdir(parents=True, exist_ok=True)
image_map_out.write_text(json.dumps(IMAGE_PROXY_MAP, ensure_ascii=False, sort_keys=True), encoding="utf-8")
print(f"Generated: {image_map_out}  ({len(IMAGE_PROXY_MAP)} proxied images)")

# ── Google Analytics 4, everywhere ────────────────────────────────────────────
#
# Run last, over the finished public/ tree, rather than folding GA4 into
# GOOGLE_ADS_TAG. The hand-written pages — about, contact, the two policy pages,
# review — never go through with_meta_pixel() and carry no Google tag at all, so
# a tag bolted onto the generated pages alone would silently miss them and
# undercount sessions. This pass reaches every page the site actually serves,
# including ones added later.
#
# public/admin/ is excluded on purpose: the shop's own staff traffic should not
# land in the analytics that Ads reads.
if GA4_MEASUREMENT_ID:
    _public = Path(__file__).parent / "public"
    _tagged = 0
    for _page in sorted(_public.rglob("*.html")):
        if "admin" in _page.relative_to(_public).parts:
            continue
        _html = _page.read_text(encoding="utf-8")
        # Match the loader, not the bare id: checkout carries the id in a JS
        # constant for the purchase event, and testing for the id alone made
        # this pass think checkout was already tagged and skip it.
        if f"gtag/js?id={GA4_MEASUREMENT_ID}" in _html or "</head>" not in _html:
            continue
        _page.write_text(_html.replace("</head>", GA4_TAG + "\n</head>", 1), encoding="utf-8")
        _tagged += 1
    print(f"Generated: GA4 tag {GA4_MEASUREMENT_ID} on {_tagged} pages")
else:
    print("Skipped: GA4 tag (set GA4_MEASUREMENT_ID to enable)")
