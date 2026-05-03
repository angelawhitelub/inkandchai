"""
Generates akshar_co.html — the Akshar & Co. homepage with real book data
embedded from the 99bookstores scrape at ~/InkAndChaiBooks/ALL_BOOKS.json.
"""

import json, re
from datetime import datetime, timedelta
from pathlib import Path
from collections import Counter, defaultdict

# Anything scraped within the last NEW_ARRIVAL_DAYS is flagged as a new arrival.
NEW_ARRIVAL_DAYS = 30
_new_cutoff = (datetime.utcnow() - timedelta(days=NEW_ARRIVAL_DAYS)).isoformat()

def make_slug(title, shopify_id):
    """Generate a clean URL slug from title + last 5 chars of shopify_id."""
    slug = re.sub(r'[^a-z0-9]+', '-', (title or '').lower())
    slug = slug.strip('-')[:55]
    suffix = str(shopify_id or '')[-5:]
    return f"{slug}-{suffix}" if suffix else slug

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
INDIAN_CATS = {
    "mythology", "amish tripathi books", "indian writing", "spirituality",
    "best of spirituality and mythology", "chitra banerjee divakaruni books",
    "kevin missal books", "sudha murti special", "akshat gupta books",
}

def tab_for(cat):
    c = cat.lower()
    if c in FICTION_CATS:       return "Fiction"
    if c in NONFICTION_CATS:    return "Non-Fiction"
    if c in POETRY_CATS:        return "Poetry"
    if c in INDIAN_CATS:        return "Indian Authors"
    return "All"

# ── Slim book objects for JS ─────────────────────────────────────────────────
slim = []
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

    slim.append({
        "t":    b["title"][:80],
        "a":    b.get("author", "")[:50],
        "p":    price_str,
        "op":   orig_str,
        "img":  b.get("image_url", ""),
        "url":  b.get("url", ""),   # kept for cart ID compatibility
        "slug": make_slug(b["title"], b.get("shopify_id", "")),
        "cat":  b.get("category", ""),
        "tab":  tab_for(b.get("category", "")),
        "desc": (b.get("description") or "")[:800],
        "isbn": b.get("isbn", ""),
        "pub":  b.get("publisher", ""),
        "n":    is_new,            # 1 = New Arrival
        "ts":   scraped,           # so we can sort newest-first when needed
    })

# Put new arrivals at the very front so they're discoverable on first scroll
slim.sort(key=lambda x: (-x["n"], -(x["ts"] or "")[:19].count("0")))  # new first

books_js = json.dumps(slim, ensure_ascii=False)
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
            url  = b.get("image_url") or b.get("img") or ""
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
    "telephone": "+91-9625836117",
    "contactType": "customer support",
    "email": "support@inkandchai.in",
    "availableLanguage": ["English", "Hindi"]
  },
  "sameAs": ["https://wa.me/919625836117"],
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
  // Apply saved theme BEFORE paint to avoid flash of wrong theme
  (function(){ try { var t = localStorage.getItem('iac_theme'); if (t === 'light') document.documentElement.setAttribute('data-theme','light'); } catch(e){} })();
  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme');
    var next = cur === 'light' ? '' : 'light';
    if (next) document.documentElement.setAttribute('data-theme', next);
    else      document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('iac_theme', next); } catch(e){}
  }
</script>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=Montserrat:wght@300;400;500&display=swap" rel="stylesheet" />
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
  body { background: var(--bg); color: var(--cream); font-family: 'Montserrat', sans-serif; font-weight: 300; overflow-x: hidden; min-height: 100vh; }
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
  .nav-actions { display: flex; gap: 1.4rem; align-items: center; }
  .nav-icon { color: var(--cream-dim); cursor: pointer; transition: color 0.3s; font-size: 1rem; }
  .nav-icon:hover { color: var(--gold); }
  .btn-nav { font-family: 'Montserrat', sans-serif; font-size: 0.62rem; letter-spacing: 0.22em; text-transform: uppercase; padding: 0.55rem 1.4rem; border: 1px solid var(--gold-dim); color: var(--gold); background: transparent; cursor: pointer; transition: all 0.3s; text-decoration: none; }
  .btn-nav:hover { background: var(--gold); color: var(--bg); border-color: var(--gold); }

  /* HERO */
  .hero { min-height: 100vh; display: grid; grid-template-columns: 1fr 1fr; position: relative; overflow: hidden; }
  .hero-left { display: flex; flex-direction: column; justify-content: center; padding: 10rem 5rem 6rem 6rem; position: relative; z-index: 2; }
  .hero-eyebrow { font-size: 0.62rem; letter-spacing: 0.35em; text-transform: uppercase; color: var(--gold); margin-bottom: 2rem; display: flex; align-items: center; gap: 1rem; }
  .hero-eyebrow::before { content: ''; display: inline-block; width: 40px; height: 1px; background: var(--gold); }
  .hero-title { font-family: 'Cormorant Garamond', serif; font-size: clamp(3.2rem, 6vw, 5.5rem); font-weight: 300; line-height: 1.08; color: var(--white); margin-bottom: 2rem; }
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

  /* SECTIONS SHARED */
  section { padding: 7rem 6rem; }
  .section-label { font-size: 0.6rem; letter-spacing: 0.35em; text-transform: uppercase; color: var(--gold); margin-bottom: 1rem; display: flex; align-items: center; gap: 1rem; }
  .section-label::before { content: ''; display: inline-block; width: 30px; height: 1px; background: var(--gold); }
  .section-title { font-family: 'Cormorant Garamond', serif; font-size: clamp(2rem, 4vw, 3.2rem); font-weight: 300; color: var(--white); line-height: 1.15; margin-bottom: 1rem; }
  .section-title em { font-style: italic; color: var(--gold-light); }

  /* FEATURED BOOKS */
  .featured { background: var(--bg2); }
  .featured-header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 4rem; }
  .tabs { display: flex; gap: 0.4rem; border-bottom: 1px solid var(--border); padding-bottom: 0; margin-top: 1.5rem; }
  .tab { font-size: 0.62rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--cream-dim); padding: 0.5rem 1.2rem 0.8rem; cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.3s; margin-bottom: -1px; background: none; border-top: none; border-left: none; border-right: none; font-family: 'Montserrat', sans-serif; }
  .tab.active { color: var(--gold); border-bottom-color: var(--gold); }
  .tab:hover { color: var(--gold-light); }

  /* Book grid */
  .books-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 1.4rem; }
  @media(max-width:1100px){ .books-grid { grid-template-columns: repeat(4, 1fr); } }
  @media(max-width:880px) { .books-grid { grid-template-columns: repeat(3, 1fr); } }
  .book-card { cursor: pointer; }
  .book-cover { aspect-ratio: 2/3; max-height: 320px; position: relative; overflow: hidden; margin-bottom: 1rem; border: 1px solid var(--border); background: #1a1208; display: flex; align-items: center; justify-content: center; }
  /* contain (not cover) so wide combo images aren't cropped — full image always visible */
  .book-cover img { width: 100%; height: 100%; object-fit: contain; display: block; transition: transform 0.5s ease; }
  .book-card:hover .book-cover img { transform: scale(1.04); }
  @media(max-width:780px) { .book-cover { max-height: 220px; margin-bottom: 0.7rem; } }
  .book-cover-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.65); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.6rem; opacity: 0; transition: opacity 0.3s; padding: 1rem; }
  .book-card:hover .book-cover-overlay { opacity: 1; }
  .book-cover-title { font-family: 'Cormorant Garamond', serif; font-size: 0.9rem; color: var(--white); text-align: center; line-height: 1.3; }
  .btn-add { font-size: 0.58rem; letter-spacing: 0.22em; text-transform: uppercase; color: var(--bg); background: var(--gold); border: none; padding: 0.7rem 1.4rem; cursor: pointer; font-family: 'Montserrat', sans-serif; font-weight: 500; transition: background 0.3s; }
  .btn-add:hover { background: var(--gold-light); }

  /* Always-visible Add to Cart button below each book card */
  .btn-add-card { width: 100%; margin-top: 0.6rem; font-family: 'Montserrat', sans-serif; font-size: 0.54rem; letter-spacing: 0.18em; text-transform: uppercase; padding: 0.55rem 0.4rem; background: transparent; color: var(--gold); border: 1px solid rgba(201,168,76,0.4); cursor: pointer; font-weight: 500; transition: all 0.25s; }
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
  .search-wrap { margin-bottom: 2rem; }
  .search-input { width: 100%; max-width: 480px; background: var(--bg3); border: 1px solid var(--border); color: var(--cream); padding: 0.75rem 1.2rem; font-family: 'Montserrat', sans-serif; font-size: 0.78rem; outline: none; transition: border-color 0.3s; letter-spacing: 0.04em; }
  .search-input::placeholder { color: var(--cream-dim); }
  .search-input:focus { border-color: var(--gold-dim); }

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
  @keyframes fadeUp { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }
  .hero-eyebrow { animation: fadeUp 0.8s ease 0.2s both; }
  .hero-title    { animation: fadeUp 0.8s ease 0.4s both; }
  .hero-sub      { animation: fadeUp 0.8s ease 0.6s both; }
  .hero-ctas     { animation: fadeUp 0.8s ease 0.8s both; }
  .hero-stats    { animation: fadeUp 0.8s ease 1s both; }

  /* ALL CATEGORIES */
  .all-categories { background: var(--bg3); border-top: 1px solid var(--border); }
  .cat-search-wrap { margin: 2rem 0 2.5rem; }
  .cat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem; }
  .cat-card {
    border: 1px solid var(--border); padding: 1.4rem 1.6rem; cursor: pointer;
    transition: border-color 0.3s, background 0.3s; position: relative; overflow: hidden;
  }
  .cat-card:hover { border-color: var(--gold-dim); background: rgba(201,168,76,0.05); }
  .cat-card.active-cat { border-color: var(--gold); background: rgba(201,168,76,0.08); }
  .cat-card::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
    background: var(--gold); transform: scaleY(0); transition: transform 0.3s; transform-origin: bottom;
  }
  .cat-card:hover::before, .cat-card.active-cat::before { transform: scaleY(1); }
  .cat-name { font-family: 'Cormorant Garamond', serif; font-size: 1rem; color: var(--cream); line-height: 1.3; margin-bottom: 0.3rem; }
  .cat-count { font-size: 0.58rem; letter-spacing: 0.2em; text-transform: uppercase; color: var(--gold-dim); }

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
    .books-grid { grid-template-columns: 1fr 1fr; gap: 1rem; }
    .hero { min-height:auto; }
    .hero-title { font-size:clamp(2.45rem,13vw,3.45rem); line-height:1.04; margin-bottom:1.3rem; }
    .hero-sub { width:auto; max-width:330px; margin-bottom:1.55rem; font-size:0.76rem; line-height:1.75; }
    .hero-ctas { flex-direction:column; align-items:stretch; }
    .hero-eyebrow,.hero-title,.hero-sub,.hero-ctas,.hero-stats{animation:none;opacity:1;transform:none}
    .hero-stats { display:none; }
    .stat-num { font-size:1.35rem; }
    .stat-label { font-size:0.48rem; }
    .hero-left { padding:5.6rem 1.2rem 1rem; max-width:100vw; overflow:hidden; }
    .hero-right { padding:0.5rem 1.2rem 3rem; max-width:100vw; }
    .hero-cover-wall { grid-template-columns:repeat(2,1fr); gap:0.75rem; width:calc(100vw - 2.4rem); max-width:calc(100vw - 2.4rem); }
    .hero-cover-card:nth-child(2),.hero-cover-card:nth-child(5),.hero-cover-card:nth-child(4),.hero-cover-card:nth-child(7){transform:none}
    .hero-cover-card:nth-child(7){display:none}
  }
  /* Promo banner above nav */
  .promo-banner{background:linear-gradient(90deg,#1a1410,#2a1f15,#1a1410);border-bottom:1px solid rgba(201,168,76,0.25);padding:0.55rem 1rem;text-align:center;font-size:0.66rem;letter-spacing:0.12em;color:#f0e8d8;font-family:'Montserrat',sans-serif;position:relative;z-index:200}
  .promo-banner strong{color:#c9a84c;font-weight:600;letter-spacing:0.18em}
  .promo-banner code{background:rgba(201,168,76,0.18);color:#c9a84c;padding:0.15rem 0.55rem;border:1px dashed rgba(201,168,76,0.5);font-family:'Montserrat',sans-serif;font-size:0.62rem;letter-spacing:0.15em;margin-left:0.5rem}
  @media(max-width:780px){.promo-banner{font-size:0.58rem;padding:0.5rem 0.7rem;letter-spacing:0.06em}}
  @media(max-width:780px){
    .hero-title { font-size:clamp(2.45rem,13vw,3.7rem); line-height:1.04; margin-bottom:1.3rem; }
    .hero-sub { width:calc(100vw - 2.4rem); max-width:calc(100vw - 2.4rem); margin-bottom:1.55rem; font-size:0.76rem; line-height:1.75; }
    .hero-ctas { flex-direction:column; align-items:stretch; }
    .hero-stats { display:none; }
    .hero-eyebrow,.hero-title,.hero-sub,.hero-ctas,.hero-stats{animation:none;opacity:1;transform:none}
    .hero-left { padding:5.6rem 1.2rem 1rem; max-width:100vw; overflow:hidden; }
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
  .trust-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:1.5rem;max-width:1200px;margin:0 auto;padding:2.5rem 2rem;border-bottom:1px solid var(--border)}
  .trust-item{display:flex;flex-direction:column;align-items:center;text-align:center;gap:0.5rem}
  .trust-icon{font-size:1.6rem;color:var(--gold)}
  .trust-title{font-family:'Cormorant Garamond',serif;font-size:1rem;color:var(--cream);font-weight:500}
  .trust-text{font-size:0.7rem;color:var(--cream-dim);line-height:1.5;letter-spacing:0.03em}
  @media(max-width:780px){.trust-strip{grid-template-columns:repeat(2,1fr);gap:1.2rem;padding:1.8rem 1rem}.trust-title{font-size:0.85rem}.trust-text{font-size:0.62rem}}

</style>
</head>
<body>

<!-- Promo banner (PhonePe-style limited offer) -->
<div class="promo-banner">
  <strong>✦ FLAT 10% OFF</strong> on prepaid orders above ₹499 &nbsp;·&nbsp; Free shipping pan-India &nbsp;<code>USE: INKLOVE10</code>
</div>

<!-- Floating WhatsApp support button -->
<a class="wa-float" href="https://wa.me/919625836117?text=Hi%20Ink%20%26%20Chai%2C%20I%20have%20a%20question%20about%20a%20book." target="_blank" rel="noopener" title="Chat with us on WhatsApp" aria-label="WhatsApp support">
  <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
</a>

<!-- Mobile bottom nav (mobile only via CSS) -->
<nav class="mob-nav" aria-label="Mobile navigation">
  <a href="/" title="Home"><span class="mn-icon">⌂</span><span>Home</span></a>
  <button onclick="window.IAC ? IAC.openMyOrders() : null" title="My Orders"><span class="mn-icon">📦</span><span>Orders</span></button>
  <button onclick="openCart()" title="Cart"><span class="mn-icon">🛒</span><span>Cart</span><span class="mn-badge" id="cartBadgeMobile" style="display:none;">0</span></button>
</nav>

<nav>
  <a class="nav-logo" href="/" aria-label="Ink and Chai — home">
    <img class="logo-img logo-dark"  src="/images/logo-light.png" alt="Ink &amp; Chai logo" width="120" height="38"/>
    <img class="logo-img logo-light" src="/images/logo.png"       alt="" width="120" height="38" aria-hidden="true"/>
  </a>
  <ul class="nav-links">
    <li><a href="#featured">Catalogue</a></li>
    <li><a href="#collections">Collections</a></li>
    <li><a href="#categories">Categories</a></li>
    <li><a href="/track/">Track Order</a></li>
    <li><a href="/terms/">Terms</a></li>
    <li><a href="/privacy-policy/">Privacy</a></li>
    <li><a href="/refund-policy/">Refund</a></li>
    <li><a href="/return-policy/">Returns</a></li>
    <li><a href="/shipping-policy/">Shipping</a></li>
    <li><a href="mailto:support@inkandchai.in">Contact Us</a></li>
  </ul>
  <div class="nav-actions">
    <button class="theme-toggle" onclick="toggleTheme()" title="Toggle light/dark mode" aria-label="Toggle theme"><span class="moon">🌙</span><span class="sun">☀️</span></button>
    <span class="nav-icon" title="Search" onclick="document.getElementById('searchInput')?.focus();document.getElementById('featured')?.scrollIntoView({behavior:'smooth'})">&#9906;</span>
    <span class="nav-icon" title="Wishlist" onclick="openWishlistModal()">&#9825;<span id="wishBadge" style="display:none;font-size:0.55rem;background:var(--gold);color:var(--bg);border-radius:50%;width:14px;height:14px;display:none;align-items:center;justify-content:center;position:absolute;top:-4px;right:-6px;"></span></span>
    <button class="btn-nav" onclick="window.IAC ? IAC.openMyOrders() : null" style="margin-right:0.3rem;">📦 My Orders</button>
    <button class="btn-nav auth-nav-btn" id="authNavBtnMain" onclick="window.IAC ? IAC.openAuthModal() : null">👤 Sign In</button>
    <div class="nav-cart-wrap">
      <button class="btn-nav" onclick="openCart()" style="cursor:pointer;">Cart</button>
      <span class="cart-badge" id="cartBadge" style="display:none;">0</span>
    </div>
  </div>
</nav>

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
      <a href="/category/?name=Hindi%20Books" class="btn-primary">Shop Hindi Editions</a>
      <a href="#featured" class="btn-ghost">See Bestsellers</a>
    </div>
    <div class="hero-stats">
      <div><div class="stat-num">Hindi</div><div class="stat-label">Self-help focus</div></div>
      <div><div class="stat-num">₹499+</div><div class="stat-label">Free shipping</div></div>
      <div><div class="stat-num">COD</div><div class="stat-label">UPI available</div></div>
    </div>
  </div>
  <div class="hero-right">
    <div class="hero-cover-wall" aria-label="Hindi self-help featured books">
      <a class="hero-cover-card featured" href="/product/?id=can-t-hurt-me-hindi-ME-HI" data-label="Can't Hurt Me · Hindi">
        <img src="/images/cant-hurt-me-hindi.jpg" alt="Can't Hurt Me Hindi edition" loading="eager" fetchpriority="high"/>
      </a>
      <a class="hero-cover-card" href="/product/?id=never-finished-hindi-ED-HI" data-label="Never Finished">
        <img src="/images/never-finished-hindi.jpg" alt="Never Finished Hindi edition" loading="eager"/>
      </a>
      <a class="hero-cover-card featured" href="/product/?id=the-hard-thing-about-hard-things-hindi-NG-HI" data-label="The Hard Thing · Hindi">
        <img src="/images/hard-thing-about-hard-things-hindi.jpg" alt="The Hard Thing About Hard Things Hindi edition" loading="eager"/>
      </a>
      <a class="hero-cover-card" href="/product/?id=thinking-fast-and-slow-hindi-OW-HI" data-label="Thinking, Fast and Slow">
        <img src="/images/thinking-fast-slow-hindi.jpg" alt="Thinking Fast and Slow Hindi edition" loading="eager"/>
      </a>
      <a class="hero-cover-card" href="/product/?id=hindi-rich-dad-poor-dad-80989" data-label="Rich Dad Poor Dad">
        <img src="https://cdn.shopify.com/s/files/1/0777/8100/8701/files/18a3b96e-fe0b-4de2-99ba-d6900b02f8b0.jpg?v=1697648603" alt="Rich Dad Poor Dad Hindi edition" loading="lazy"/>
      </a>
      <a class="hero-cover-card featured" href="/product/?id=hindi-atomic-habits-33309" data-label="Atomic Habits">
        <img src="https://cdn.shopify.com/s/files/1/0777/8100/8701/files/51nmc82kxql-1c1458a1-51a7-4d5d-b100-4255d57076aa.jpg?v=1697649002" alt="Atomic Habits Hindi edition" loading="lazy"/>
      </a>
      <a class="hero-cover-card" href="/product/?id=shakti-ke-48-niyam-the-48-laws-of-power-hindi-28157" data-label="48 Laws of Power">
        <img src="https://cdn.shopify.com/s/files/1/0777/8100/8701/files/51-RRmYWh9L._SL1000.jpg?v=1700040895" alt="48 Laws of Power Hindi edition" loading="lazy"/>
      </a>
    </div>
    <div class="hero-note"><strong>Translated picks:</strong> motivation, money, business, psychology, discipline.</div>
  </div>
</section>

<!-- HERO BANNER CAROUSEL -->
<div class="banners" id="bannerCarousel" aria-roledescription="carousel" aria-label="Promotional banners">
  <div class="banner-viewport">
    <div class="banner-track" id="bannerTrack">
      <div class="banner-slide" data-slide="0" onclick="bannerLink(0)">
        <picture>
          <source media="(max-width:780px)" srcset="/images/banners/banner1-mobile.jpg">
          <img src="/images/banners/banner1.jpg" alt="The Bestseller Haul — Free delivery on orders above ₹599 — Use coupon FREESHIPPING" loading="eager" fetchpriority="high" decoding="async" width="2000" height="800">
        </picture>
      </div>
      <div class="banner-slide" data-slide="1" onclick="bannerLink(1)">
        <picture>
          <source media="(max-width:780px)" srcset="/images/banners/banner2-mobile.jpg">
          <img src="/images/banners/banner2.jpg" alt="Hindi Self Help Books — Up to 50% off" loading="lazy" decoding="async" width="2000" height="800">
        </picture>
      </div>
      <div class="banner-slide" data-slide="2" onclick="bannerLink(2)">
        <picture>
          <source media="(max-width:780px)" srcset="/images/banners/banner3-mobile.jpg">
          <img src="/images/banners/banner3.jpg" alt="Mega Festive Sale — Order above ₹799 and get 1 book free with coupon GET1FREE" loading="lazy" decoding="async" width="2000" height="800">
        </picture>
      </div>
    </div>
    <button class="banner-arrow prev" onclick="bannerGo(-1)" aria-label="Previous banner">‹</button>
    <button class="banner-arrow next" onclick="bannerGo(1)"  aria-label="Next banner">›</button>
    <div class="banner-dots" role="tablist">
      <button class="banner-dot active" data-i="0" onclick="bannerSet(0)" aria-label="Go to banner 1"></button>
      <button class="banner-dot"        data-i="1" onclick="bannerSet(1)" aria-label="Go to banner 2"></button>
      <button class="banner-dot"        data-i="2" onclick="bannerSet(2)" aria-label="Go to banner 3"></button>
    </div>
  </div>
</div>
<script>
  (function() {
    const track = document.getElementById('bannerTrack');
    const dots  = document.querySelectorAll('.banner-dot');
    const N = 3;
    let i = 0, timer = null, paused = false;
    const BANNER_LINKS = [
      '/?cat=All Self Help',                    // Bestseller haul → self-help category
      '/category/?name=All%20Self%20Help',      // Hindi self-help
      '/'                                        // Festive sale → homepage
    ];

    function render() {
      track.style.transform = `translateX(-${i * 100}%)`;
      dots.forEach((d, idx) => d.classList.toggle('active', idx === i));
    }
    window.bannerSet = function(n) { i = ((n % N) + N) % N; render(); restart(); };
    window.bannerGo  = function(d) { bannerSet(i + d); };
    window.bannerLink = function(n) { window.location.href = BANNER_LINKS[n] || '/'; };

    function tick() { if (!paused) { i = (i + 1) % N; render(); } }
    function start()   { stop(); timer = setInterval(tick, 5000); }
    function stop()    { if (timer) clearInterval(timer); timer = null; }
    function restart() { start(); }

    // Pause on hover (desktop)
    const carousel = document.getElementById('bannerCarousel');
    carousel.addEventListener('mouseenter', () => { paused = true; });
    carousel.addEventListener('mouseleave', () => { paused = false; });

    // Touch swipe on mobile
    let startX = 0, dx = 0;
    track.addEventListener('touchstart', e => { startX = e.touches[0].clientX; dx = 0; paused = true; }, { passive: true });
    track.addEventListener('touchmove',  e => { dx = e.touches[0].clientX - startX; }, { passive: true });
    track.addEventListener('touchend',   () => {
      if (Math.abs(dx) > 50) bannerGo(dx < 0 ? 1 : -1);
      paused = false;
    });

    // Pause when tab hidden — saves CPU
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop(); else start();
    });

    start();
  })();
</script>

<!-- MARQUEE -->
<div class="marquee-bar">
  <div class="marquee-track">
    <span class="marquee-item">Free shipping above ₹499 <span class="marquee-dot">◆</span></span>
    <span class="marquee-item">New arrivals every Friday <span class="marquee-dot">◆</span></span>
    <span class="marquee-item">Same-day delivery in Delhi NCR <span class="marquee-dot">◆</span></span>
    <span class="marquee-item">Gift wrapping available <span class="marquee-dot">◆</span></span>
    <span class="marquee-item">10% off on orders above ₹999 <span class="marquee-dot">◆</span></span>
    <span class="marquee-item">Free shipping above ₹499 <span class="marquee-dot">◆</span></span>
    <span class="marquee-item">New arrivals every Friday <span class="marquee-dot">◆</span></span>
    <span class="marquee-item">Same-day delivery in Delhi NCR <span class="marquee-dot">◆</span></span>
    <span class="marquee-item">Gift wrapping available <span class="marquee-dot">◆</span></span>
    <span class="marquee-item">10% off on orders above ₹999 <span class="marquee-dot">◆</span></span>
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
    <a href="#" class="btn-ghost" style="margin-bottom:1rem;" id="view-all-link">View all books</a>
  </div>

  <div class="search-wrap">
    <input class="search-input" type="text" id="searchInput" placeholder="Search by title or author…" oninput="onSearch()" />
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
          💬 <a href="https://wa.me/919625836117" target="_blank" style="color:var(--gold);text-decoration:none;">+91 96258 36117 (WhatsApp)</a><br/>
          📍 New Delhi – 110006
        </p>
      </div>
    </div>
    <div>
      <div class="footer-col-title">Shop</div>
      <ul class="footer-links">
        <li><a href="#featured">All Books</a></li>
        <li><a href="#collections">Collections</a></li>
        <li><a href="#categories">Categories</a></li>
        <li><a href="#featured">New Arrivals</a></li>
        <li><a href="#featured" onclick="setTab(document.querySelector('.tab[data-tab=&quot;Bestsellers&quot;]'))">Bestsellers</a></li>
      </ul>
    </div>
    <div>
      <div class="footer-col-title">Help</div>
      <ul class="footer-links">
        <li><a href="/shipping-policy/">Shipping Info</a></li>
        <li><a href="/return-policy/">Returns</a></li>
        <li><a href="/refund-policy/">Refund Policy</a></li>
        <li><a href="mailto:support@inkandchai.in">Contact Us</a></li>
        <li><a href="https://wa.me/919625836117" target="_blank">WhatsApp Support</a></li>
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
<a href="https://wa.me/919625836117" target="_blank" rel="noopener"
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

const TRENDING_PATTERNS = [
  ['onyx storm', 120],
  ['sunrise on the reaping', 118],
  ['the let them theory', 116],
  ['great big beautiful life', 114],
  ['the tenant', 112],
  ['the housemaid', 110],
  ['king of gluttony', 108],
  ['twisted love', 106],
  ['it ends with us', 104],
  ['atomic habits', 102],
  ['the psychology of money', 100],
  ['rich dad poor dad', 98],
  ["don't believe everything you think", 96],
  ['dont believe everything you think', 96],
  ["can't hurt me", 94],
  ['cant hurt me', 94],
  ['never finished', 92],
  ['the hidden hindu', 90],
  ['the subtle art of not giving', 88],
  ['48 laws of power', 86],
  ['ikigai', 84],
  ['the alchemist', 82],
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
  let penalty = 0;
  if (t.includes('combo') || t.includes('set of')) penalty += 6;
  if (t.includes('preloved')) penalty += 5;
  if (t.includes('workbook')) penalty += 4;
  if (t.includes('movie edition')) penalty += 2;
  return penalty;
}

function homepageRank(a, b) {
  return trendScore(b) - trendScore(a)
    || editionPenalty(a) - editionPenalty(b)
    || (b.n || 0) - (a.n || 0)
    || a.t.localeCompare(b.t);
}

function filteredBooks() {
  const q = currentQuery.toLowerCase();
  return BOOKS.filter(b => {
    const tabOk  = currentTab === 'All'
                || (currentTab === 'New' && b.n === 1)
                || (currentTab === 'Bestsellers' && trendScore(b) > 0)
                || b.tab === currentTab;
    const queryOk = !q || b.t.toLowerCase().includes(q) || (b.a && b.a.toLowerCase().includes(q));
    return tabOk && queryOk;
  }).sort(homepageRank);
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
      <div class="book-cover" style="position:relative;" onclick="location.href='/product/?id=${b.slug}'">
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
      <div class="book-name" onclick="location.href='/product/?id=${b.slug}'">${escHtml(b.t)}</div>
      <div class="book-author" onclick="location.href='/product/?id=${b.slug}'">${escHtml(b.a || '')}</div>
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
  btn.style.display = books.length > visibleCount ? 'inline-block' : 'none';
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
      <div class="book-cover" onclick="location.href='/product/?id=${b.slug}'">
        <img src="${b.img}" alt="${escHtml(b.t)}" loading="lazy" onerror="this.style.display='none'" />
        <div class="book-cover-overlay">
          <div class="book-cover-title">${escHtml(b.t)}</div>
        </div>
      </div>
      <div class="book-name" onclick="location.href='/product/?id=${b.slug}'">${escHtml(b.t)}</div>
      <div class="book-author" onclick="location.href='/product/?id=${b.slug}'">${escHtml(b.a || '')}</div>
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

// ── CONTROLS ──────────────────────────────────────────────────────────────
function setTab(el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  currentTab   = el.dataset.tab;
  visibleCount = PAGE_SIZE;
  renderBooks();
}

function onSearch() {
  currentQuery = document.getElementById('searchInput').value;
  visibleCount = PAGE_SIZE;
  renderBooks();
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


// ── CATEGORIES ────────────────────────────────────────────────────────────
let activeCat = null;

function renderCats(list) {
  document.getElementById('catGrid').innerHTML = list.map(c => `
    <a class="cat-card" href="/category/?name=${encodeURIComponent(c.name)}" style="text-decoration:none;color:inherit;">
      <div class="cat-name">${escHtml(c.name)}</div>
      <div class="cat-count">${c.count} books</div>
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
      <div class="book-cover" onclick="location.href='/product/?id=${b.slug}'" style="position:relative;">
        ${b.n ? '<span class="new-badge">NEW</span>' : ''}
        <img src="${b.img}" alt="${escHtml(b.t)}" loading="lazy" onerror="this.style.display='none'" />
      </div>
      <div class="book-name" onclick="location.href='/product/?id=${b.slug}'">${escHtml(b.t)}</div>
      <div class="book-author" onclick="location.href='/product/?id=${b.slug}'">${escHtml(b.a || '')}</div>
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

// ── INIT ──────────────────────────────────────────────────────────────────
const totalStat = document.getElementById('stat-total');
if (totalStat) totalStat.textContent = BOOKS.length.toLocaleString() + '+';
document.getElementById('view-all-link').textContent = `View all ${BOOKS.length.toLocaleString()} books`;
renderBooks();
renderCollections();
renderCats(ALL_CATS);

// Intersection observer for initial cards
const obs = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      e.target.style.opacity = '1';
      e.target.style.transform = 'translateY(0)';
    }
  });
}, { threshold: 0.08 });
document.querySelectorAll('.coll-card').forEach(el => {
  el.style.opacity = '0'; el.style.transform = 'translateY(25px)';
  el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
  obs.observe(el);
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
HTML = HTML.replace("RAZORPAY_PUB_KEY_PLACEHOLDER",   os.environ.get("RAZORPAY_KEY_ID", "rzp_test_CHANGE_ME"))
HTML = HTML.replace("SUPABASE_URL_PLACEHOLDER",       os.environ.get("SUPABASE_URL", ""))
HTML = HTML.replace("SUPABASE_ANON_KEY_PLACEHOLDER",  os.environ.get("SUPABASE_ANON_KEY", ""))

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
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=Montserrat:wght@300;400;500&display=swap" rel="stylesheet"/>
<script>
  (function(){ try { var t = localStorage.getItem('iac_theme'); if (t === 'light') document.documentElement.setAttribute('data-theme','light'); } catch(e){} })();
  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme');
    var next = cur === 'light' ? '' : 'light';
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
body{background:var(--bg);color:var(--cream);font-family:'Montserrat',sans-serif;font-weight:300;min-height:100vh}

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
.product-page{max-width:1100px;margin:0 auto;padding:4rem 2rem 6rem;display:grid;grid-template-columns:1fr 1.4fr;gap:5rem;align-items:start}
@media(max-width:780px){
  html,body{overflow-x:hidden}
  .product-page{grid-template-columns:1fr;gap:1.2rem;padding:0 1rem 90px;display:block}
  .prod-cover-wrap{position:sticky;top:55px;z-index:50;background:var(--bg);padding:0.6rem 0;margin:0 -1rem 0.8rem;padding-left:1rem;padding-right:1rem;border-bottom:1px solid var(--border)}
  .prod-cover{min-height:auto;padding:0.6rem;background:transparent;border:none}
  .prod-cover img{max-height:160px;box-shadow:0 6px 20px rgba(0,0,0,0.6)}
  .prod-badges{margin-top:0.5rem}
  .prod-actions{display:none}
  .prod-bottom-bar{display:flex!important}
  .prod-info{gap:1rem}
  .prod-title{font-size:1.5rem!important}
  .prod-price{font-size:2rem!important}
}

/* LEFT — cover */
.prod-cover-wrap{position:sticky;top:6rem}
.prod-cover{background:var(--bg2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;padding:2.5rem;min-height:380px}
.prod-cover img{max-height:480px;max-width:100%;object-fit:contain;box-shadow:0 24px 64px rgba(0,0,0,0.6);display:block}
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

/* RELATED */
.related{max-width:1100px;margin:0 auto;padding:0 2rem 6rem}
.related-title{font-family:'Cormorant Garamond',serif;font-size:1.8rem;font-weight:300;color:var(--white);margin-bottom:2rem}
.related-title em{font-style:italic;color:var(--gold-light)}
.related-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1.5rem}
@media(max-width:780px){.related-grid{grid-template-columns:repeat(2,1fr)}}
.rel-card{cursor:pointer;transition:opacity 0.2s}
.rel-card:hover{opacity:0.85}
.rel-cover{aspect-ratio:2/3;background:var(--bg2);border:1px solid var(--border);overflow:hidden;margin-bottom:0.8rem}
.rel-cover img{width:100%;height:100%;object-fit:contain;display:block;background:#1a1208}
.rel-title{font-family:'Cormorant Garamond',serif;font-size:0.95rem;color:var(--cream);line-height:1.3;margin-bottom:0.2rem}
.rel-price{font-size:0.85rem;color:var(--gold)}

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
@media(max-width:780px){.promo-banner{font-size:0.58rem;padding:0.5rem 0.7rem;letter-spacing:0.06em}}

/* WhatsApp floating */
.wa-float{position:fixed;bottom:22px;left:22px;width:54px;height:54px;border-radius:50%;background:#25d366;color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(37,211,102,0.45);z-index:250;cursor:pointer;text-decoration:none;transition:transform 0.2s}
.wa-float:hover{transform:scale(1.08)}
@media(max-width:780px){.wa-float{bottom:84px;left:14px;width:48px;height:48px}}
</style>
</head>
<body>

<!-- Promo banner -->
<div class="promo-banner">
  <strong>✦ FLAT 10% OFF</strong> on prepaid orders above ₹499 &nbsp;·&nbsp; Free shipping pan-India &nbsp;<code>USE: INKLOVE10</code>
</div>

<!-- WhatsApp -->
<a class="wa-float" href="https://wa.me/919625836117?text=Hi%20Ink%20%26%20Chai%2C%20I%20have%20a%20question%20about%20a%20book." target="_blank" rel="noopener" title="Chat with us on WhatsApp" aria-label="WhatsApp support">
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

// ── Render product page ───────────────────────────────────────────────────
function renderProduct(b) {
  const pageTitle = b.t + (b.a ? ' by ' + b.a : '') + ' — Buy Online at Ink & Chai';
  const shortDesc = (b.desc || '').slice(0, 250) || ('Buy ' + b.t + (b.a ? ' by ' + b.a : '') + ' online at Ink & Chai. Fast pan-India delivery, free shipping above ₹499, 7-day easy returns.');
  const canonical = 'https://inkandchai.in/product/?id=' + b.slug;
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
        "inLanguage": (b.t && /हिं|हि|—\s*[ऀ-ॿ]/.test(b.t)) ? "hi" : "en",
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
          "ratingValue": "4.7",
          "reviewCount": "128"
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
            ? `<img src="${esc(b.img)}" alt="${esc(b.t)} — ${esc(b.a||'book')} cover" loading="eager" fetchpriority="high" decoding="async" />`
            : `<div class="prod-cover-placeholder"></div>`}
        </div>
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
        <div class="prod-rating">
          <span class="prod-stars">★★★★★</span>
          <span class="prod-rating-label">Bestseller · Loved by readers across India</span>
        </div>

        <div class="divider"></div>

        <div class="prod-price-row">
          <span class="prod-price">${esc(b.p)}</span>
          ${b.op ? `<span class="prod-orig">${esc(b.op)}</span>` : ''}
          ${savePct ? `<span class="prod-saving">Save ${savePct}%</span>` : ''}
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
          <div class="prod-meta-item"><div class="prod-meta-label">Payment</div><div class="prod-meta-val">UPI · Cards · Net Banking</div></div>
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
          <button class="btn-cart" data-slug="${esc(b.slug)}" onclick="addBookToCart(this.dataset.slug)">
            + Add to Cart
          </button>
          <button class="btn-cod" data-slug="${esc(b.slug)}" onclick="addBookToCart(this.dataset.slug); window.location.href='/checkout/';">
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
      </div>
    </div>

    <!-- Mobile sticky bottom bar (shown only on mobile via CSS) -->
    <div class="prod-bottom-bar">
      <button class="pbb-cart" data-slug="${esc(b.slug)}" onclick="addBookToCart(this.dataset.slug)">
        + Add to Cart
      </button>
      <button class="pbb-buy" data-slug="${esc(b.slug)}" onclick="addBookToCart(this.dataset.slug); window.location.href='/checkout/';">
        Buy Now · ${esc(b.p)}
      </button>
    </div>
  `;
  // Set initial wishlist state
  setTimeout(updateProdWishBtn, 100);
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
// Picks 2 deterministic same-category companions and shows them with
// checkboxes + bundle price + "Add Bundle to Cart".
function renderFBT(b) {
  const same = BOOKS.filter(x => x.cat === b.cat && x.url !== b.url && x.img && x.p);
  if (same.length < 2) {
    // Try same tab if same category is too sparse
    const fallback = BOOKS.filter(x => x.tab === b.tab && x.url !== b.url && x.img && x.p);
    if (fallback.length < 2) { document.getElementById('fbtContent').innerHTML = ''; return; }
    same.push(...fallback.filter(x => !same.includes(x)));
  }
  // Pick 2 deterministically (based on slug hash) so a given product always shows
  // the same companions — looks reliable, not random.
  const hash = (b.slug || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const pick = (offset) => same[(hash + offset) % same.length];
  const pair = [pick(7), pick(13)].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i);
  if (pair.length < 1) { document.getElementById('fbtContent').innerHTML = ''; return; }

  // Stash full items on window so the button handler can read them
  const items = [b, ...pair];
  window.__fbtItems = items;

  const priceOf = it => parseFloat((it.p || '').replace(/[^0-9.]/g, '')) || 0;
  const origOf  = it => parseFloat((it.op || '').replace(/[^0-9.]/g, '')) || 0;

  const rowHtml = (it, idx, isCurrent) => `
    <div class="fbt-row">
      <input type="checkbox" class="fbt-check" data-idx="${idx}" ${idx === 0 || true ? 'checked' : ''} onchange="updateFBTTotal()">
      <a class="fbt-thumb" href="${idx === 0 ? '#' : '/product/?id=' + it.slug}" onclick="${idx === 0 ? 'event.preventDefault();' : ''}">
        <img src="${esc(it.img)}" alt="${esc(it.t)}" loading="lazy"/>
      </a>
      <div class="fbt-info" onclick="${idx === 0 ? '' : `location.href='/product/?id=${it.slug}'`}">
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
            <span class="fbt-total-amt" id="fbtTotal">₹ ${priceOf(items[0]) + priceOf(items[1] || {p:'0'}) + priceOf(items[2] || {p:'0'})}</span>
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
    const isVideo = (it.type || '').toLowerCase() === 'video' || /\.(mp4|webm|mov)$/i.test(it.src || '');
    const igChip = it.instagram
      ? `<a class="bkg-ig-chip" href="${esc(it.instagram)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">↗ Instagram</a>`
      : '';
    const cap = it.caption ? `<div class="bkg-overlay">${esc(it.caption)}</div>` : '';
    if (isVideo) {
      const poster = it.poster ? ` poster="${esc(it.poster)}"` : '';
      return `
        <div class="bkg-card" onclick="bkgPlay(this)">
          <video src="${esc(it.src)}"${poster} preload="metadata" playsinline muted loop></video>
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

// Expose social-proof JSON to renderer
window.SOCIAL_PROOF = SOCIAL_PROOF;

// ── Related books ─────────────────────────────────────────────────────────
function renderRelated(b) {
  const related = BOOKS.filter(x => x.cat === b.cat && x.url !== b.url).slice(0, 4);
  if (!related.length) return;
  document.getElementById('relatedContent').innerHTML = `
    <div class="related">
      <h2 class="related-title">More from <em>${esc(b.cat)}</em></h2>
      <div class="related-grid">
        ${related.map(r => `
          <div class="rel-card" onclick="location.href='/product/?id=${r.slug}'">
            <div class="rel-cover">
              ${r.img ? `<img src="${esc(r.img)}" alt="${esc(r.t)}" loading="lazy"/>` : ''}
            </div>
            <div class="rel-title">${esc(r.t)}</div>
            <div class="rel-price">${esc(r.p)}</div>
          </div>`).join('')}
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

function addBookToCart(bookSlug) {
  const b = BOOK_MAP[bookSlug];
  if (!b) return;
  const price = parseFloat((b.p||'').replace(/[^0-9.]/g,'')) || 0;
  const item  = { id: b.url || bookSlug, title: b.t, author: b.a||'', price, img: b.img||'', url: b.url||'' };
  const qty   = getQty();
  // Directly write to localStorage to support qty > 1
  const CART_KEY = 'akshar_cart';
  const cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
  const existing = cart.find(i => i.id === item.id);
  if (existing) { existing.qty += qty; } else { cart.push({ ...item, qty }); }
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  if (window.refreshCart) refreshCart();
  if (window.openCart)    openCart();
  if (window.showToast)   showToast(`${qty > 1 ? qty + '× ' : ''}"${item.title.slice(0,28)}…" added to cart`);
}

// ── Init ──────────────────────────────────────────────────────────────────
const params  = new URLSearchParams(window.location.search);
const slug    = params.get('id');
const book    = slug ? BOOK_MAP[slug] : null;

if (book) {
  renderProduct(book);
  renderFBT(book);
  renderBookstagram();
  renderRelated(book);
} else {
  document.getElementById('productContent').innerHTML = `
    <div class="not-found">
      <h2>Book not found</h2>
      <p>This page may have moved. <a href="/" style="color:var(--gold)">Browse all books →</a></p>
    </div>`;
}
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

prod_out = Path(__file__).parent / "public" / "product" / "index.html"
prod_out.parent.mkdir(parents=True, exist_ok=True)
prod_out.write_text(PRODUCT_HTML, encoding="utf-8")
print(f"Generated: {prod_out}  ({len(PRODUCT_HTML.encode())//1024} KB)")
print(f"Books embedded: {len(slim)}")

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
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,400&family=Montserrat:wght@300;400;500&display=swap" rel="stylesheet"/>
<style>
:root{--bg:#0d0b08;--bg2:#141210;--bg3:#1c1916;--gold:#c9a84c;--gold-dim:#7a6330;--cream:#f0e8d8;--cream-dim:#a09080;--white:#faf7f2;--border:rgba(201,168,76,0.18)}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{max-width:100%;overflow-x:hidden;}
body{background:var(--bg);color:var(--cream);font-family:'Montserrat',sans-serif;font-weight:300;min-height:100vh}
nav{display:flex;align-items:center;justify-content:space-between;padding:1.2rem 3rem;background:rgba(13,11,8,0.97);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100;}
.logo{font-family:'Cormorant Garamond',serif;font-size:1.5rem;font-weight:600;color:var(--gold);text-decoration:none;}
.logo span{color:var(--cream);font-weight:300;font-style:italic}
.nav-back{font-size:0.62rem;letter-spacing:0.2em;text-transform:uppercase;color:var(--cream-dim);text-decoration:none;transition:color 0.2s;}
.nav-back:hover{color:var(--gold)}
main{max-width:900px;margin:0 auto;padding:3.5rem 1.5rem 6rem;}
.page-label{font-size:0.55rem;letter-spacing:0.35em;text-transform:uppercase;color:var(--gold);margin-bottom:0.6rem;}
h1{font-family:'Cormorant Garamond',serif;font-size:2.4rem;font-weight:300;color:var(--white);margin-bottom:2.5rem;}
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
.summary-total{display:flex;justify-content:space-between;align-items:baseline;padding-top:1.2rem;margin-top:0.4rem;border-top:1px solid var(--border);}
.total-label{font-size:0.58rem;letter-spacing:0.2em;text-transform:uppercase;color:var(--cream-dim);}
.total-amt{font-family:'Cormorant Garamond',serif;font-size:1.8rem;color:var(--gold);font-weight:600;}
.empty-cart{text-align:center;padding:2.5rem 1rem;color:var(--cream-dim);}
/* Form */
.form-section{display:flex;flex-direction:column;gap:0;}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem;}
.form-group{margin-bottom:1rem;}
label{display:block;font-size:0.56rem;letter-spacing:0.2em;text-transform:uppercase;color:var(--cream-dim);margin-bottom:0.45rem;}
input,textarea{width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--cream);padding:0.8rem 1rem;font-family:'Montserrat',sans-serif;font-size:0.8rem;outline:none;transition:border-color 0.2s;-webkit-appearance:none;}
input:focus,textarea:focus{border-color:rgba(201,168,76,0.5);}
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
.btn-pay{width:100%;font-family:'Montserrat',sans-serif;font-size:0.65rem;letter-spacing:0.25em;text-transform:uppercase;padding:1.1rem;background:var(--gold);color:var(--bg);border:none;cursor:pointer;font-weight:500;transition:all 0.25s;margin-bottom:0.8rem;line-height:1.4;white-space:normal;overflow-wrap:anywhere;}
.btn-pay:hover{opacity:0.88;transform:translateY(-1px);}
.btn-pay:disabled{opacity:0.5;cursor:not-allowed;transform:none;}
.btn-cod{width:100%;font-family:'Montserrat',sans-serif;font-size:0.65rem;letter-spacing:0.2em;text-transform:uppercase;padding:1rem;background:transparent;color:var(--cream);border:1px solid rgba(201,168,76,0.35);cursor:pointer;font-weight:400;transition:all 0.25s;line-height:1.4;white-space:normal;overflow-wrap:anywhere;}
.btn-cod:hover{border-color:var(--gold);color:var(--gold);}
.btn-cod:disabled{opacity:0.5;cursor:not-allowed;}
.trust-row{display:flex;gap:1.5rem;justify-content:center;margin-top:1.2rem;font-size:0.6rem;color:var(--gold-dim);letter-spacing:0.06em;flex-wrap:wrap;}
/* Success screen */
#successScreen{display:none;text-align:center;padding:4rem 2rem;max-width:560px;margin:0 auto;}
.success-icon{font-size:3.5rem;margin-bottom:1.5rem;}
.success-title{font-family:'Cormorant Garamond',serif;font-size:2.6rem;font-weight:300;color:var(--white);margin-bottom:1rem;}
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
  .btn-pay,.btn-cod{letter-spacing:0.14em;padding:1rem 0.75rem;}
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
  <a class="nav-back" href="javascript:history.back()">← Back</a>
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

        <button class="btn-pay" id="btnPayNow" onclick="submitOrder('online')">
          ⚡ Pay Now
        </button>
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
function getCart()  { try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch { return []; } }
function clearCart(){ localStorage.removeItem(CART_KEY); }

// Shipping rules — must match cart.js + server functions
const FREE_SHIPPING_THRESHOLD = 499;
const SHIPPING_FEE = 40;
function calcShipping(subtotal) { return subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE; }

// ── Render order summary ────────────────────────────────────────────────────
function renderSummary() {
  const cart = getCart();
  const container = document.getElementById('orderItems');
  const totalRow  = document.getElementById('orderTotal');
  const totalEl   = document.getElementById('totalAmt');
  const btnPay    = document.getElementById('btnPayNow');
  const btnCOD    = document.getElementById('btnCOD');

  if (!cart.length) {
    container.innerHTML = '<div class="empty-cart">Your cart is empty.<br/><a href="/" style="color:var(--gold);">Browse books →</a></div>';
    totalRow.style.display = 'none';
    if (btnPay) btnPay.disabled = true;
    if (btnCOD) btnCOD.disabled = true;
    return;
  }

  const subtotal = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const shipping = calcShipping(subtotal);
  const grand    = subtotal + shipping;
  container.innerHTML = cart.map(i => `
    <div class="order-item">
      <div class="item-img">
        ${i.img ? `<img src="${esc(i.img)}" alt="" />` : ''}
      </div>
      <div class="item-info">
        <div class="item-title">${esc(i.title)}</div>
        ${i.author ? `<div class="item-author">${esc(i.author)}</div>` : ''}
        <div class="item-qty-price">
          Qty: ${i.qty} &nbsp;·&nbsp;
          <span class="item-price-gold">₹${(i.price * i.qty).toLocaleString('en-IN')}</span>
        </div>
      </div>
    </div>`).join('') + `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:0.7rem 0;border-top:1px solid var(--border);margin-top:0.5rem;font-size:0.78rem;">
      <span style="color:var(--cream-dim);letter-spacing:0.04em;">Subtotal</span>
      <span style="color:var(--cream);">₹${subtotal.toLocaleString('en-IN')}</span>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0 0.7rem;font-size:0.78rem;">
      <span style="color:var(--cream-dim);letter-spacing:0.04em;">Shipping (Delhivery)</span>
      <span style="color:${shipping === 0 ? '#6dbf6d' : 'var(--cream)'};">${shipping === 0 ? 'FREE' : '₹' + shipping}</span>
    </div>
    ${shipping > 0 ? `<div style="font-size:0.6rem;color:var(--gold);letter-spacing:0.05em;padding:0 0 0.6rem;">💡 Add ₹${(FREE_SHIPPING_THRESHOLD - subtotal).toLocaleString('en-IN')} more to qualify for free shipping</div>` : ''}`;

  totalEl.textContent = '₹' + grand.toLocaleString('en-IN');
  totalRow.style.display = 'flex';

  // Update Pay Now button label with total
  if (btnPay) {
    btnPay.textContent = `⚡ Pay Now — ₹${grand.toLocaleString('en-IN')}`;
    btnPay.disabled = false;
  }
  if (btnCOD) btnCOD.disabled = false;
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
function setLoading(on) {
  document.getElementById('btnPayNow').disabled = on;
  document.getElementById('btnCOD').disabled    = on;
}

// ── Main submit ────────────────────────────────────────────────────────────
async function submitOrder(method) {
  const addr = collectAddr();
  if (!addr) return;
  setLoading(true);

  if (method === 'online') {
    await doRazorpay(addr);
  } else {
    await doCOD(addr);
  }
}

// ── Razorpay ───────────────────────────────────────────────────────────────
async function doRazorpay(addr) {
  const cart = getCart();
  const subtotal = cart.reduce((s,i)=>s+i.price*i.qty,0);
  const shipping = calcShipping(subtotal);
  const grand    = subtotal + shipping;
  const amtPaise = Math.round(grand * 100);

  try {
    const res = await fetch('/.netlify/functions/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: amtPaise, currency: 'INR',
        receipt: 'ic_' + Date.now(),
        notes: { customer_email: addr.email, customer_phone: addr.phone, customer_name: addr.name },
      }),
    });
    if (!res.ok) throw new Error('Order creation failed');
    const order = await res.json();

    const options = {
      key:         window.RAZORPAY_KEY_ID,
      amount:      order.amount,
      currency:    order.currency,
      name:        'Ink & Chai',
      description: `${cart.length} book${cart.length>1?'s':''}`,
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
              cart, customer: addr, amount: amtPaise, shipping,
            }),
          });
          if (!vRes.ok) throw new Error('Verification failed');
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
  const subtotal = cart.reduce((s,i)=>s+i.price*i.qty,0);
  const shipping = calcShipping(subtotal);
  const amount   = subtotal + shipping;

  try {
    const res = await fetch('/.netlify/functions/cod-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cart,
        customer: { name: addr.name, phone: addr.phone, email: addr.email, address: addr.address },
        amount, shipping,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to place order');

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
  if (!email) return;
  try {
    const res = await fetch('/.netlify/functions/auto-login-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name, phone }),
    });
    if (!res.ok) return;
    const { token_hash } = await res.json();
    if (!token_hash || !window.supabase || !window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) return;
    const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    await sb.auth.verifyOtp({ token_hash, type: 'magiclink' });
  } catch(e) { console.warn('Auto-login non-fatal:', e.message); }
}

// ── Success screen ─────────────────────────────────────────────────────────
function showSuccess(type, orderId, addr) {
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

// ── Init ───────────────────────────────────────────────────────────────────
renderSummary();

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
checkout_out.write_text(CHECKOUT_HTML, encoding="utf-8")
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
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=Montserrat:wght@300;400;500&display=swap" rel="stylesheet"/>
<script>
  (function(){ try { var t = localStorage.getItem('iac_theme'); if (t === 'light') document.documentElement.setAttribute('data-theme','light'); } catch(e){} })();
  function toggleTheme(){ var c = document.documentElement.getAttribute('data-theme'); var n = c === 'light' ? '' : 'light'; if(n) document.documentElement.setAttribute('data-theme', n); else document.documentElement.removeAttribute('data-theme'); try { localStorage.setItem('iac_theme', n); } catch(e){} }
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
<div class="promo-banner"><strong>✦ FLAT 10% OFF</strong> on prepaid orders above ₹499 &nbsp;·&nbsp; Free shipping pan-India &nbsp;<code>USE: INKLOVE10</code></div>
<nav class="mob-nav" aria-label="Mobile navigation">
  <a href="/" title="Home"><span class="mn-icon">⌂</span><span>Home</span></a>
  <a href="/" title="My Orders"><span class="mn-icon">📦</span><span>Orders</span></a>
  <a href="/" title="Cart"><span class="mn-icon">🛒</span><span>Cart</span></a>
</nav>
<a class="wa-float" href="https://wa.me/919625836117" target="_blank" rel="noopener" title="Chat on WhatsApp"><svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg></a>
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

const params = new URLSearchParams(location.search);
const collId = params.get('id');
const catName = params.get('name');

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
    <div class="book-card" onclick="location.href='/product/?id=${b.slug}'">
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

coll_out = Path(__file__).parent / "public" / "collection" / "index.html"
coll_out.parent.mkdir(parents=True, exist_ok=True)
coll_out.write_text(COLLECTION_HTML, encoding="utf-8")
print(f"Generated: {coll_out}")

# Same template handles category pages — just write a copy under /category/
cat_out = Path(__file__).parent / "public" / "category" / "index.html"
cat_out.parent.mkdir(parents=True, exist_ok=True)
cat_out.write_text(COLLECTION_HTML, encoding="utf-8")
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

    img = b.get("img", "")
    # Make relative image URLs absolute
    if img and img.startswith("/"):
        img = SITE + img

    slug = b.get("slug", "")
    link = f"{SITE}/product/?id={slug}"

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
    purl = f"{SITE}/product/?id={b['slug']}"
    img  = b.get('img', '')
    img_xml = ""
    if img:
        img_abs = img if img.startswith("http") else (SITE + img)
        img_xml = f"<image:image><image:loc>{img_abs.replace('&','&amp;')}</image:loc><image:title>{(b['t'] or '').replace('&','&amp;').replace('<','&lt;')[:200]}</image:title></image:image>"
    url_entries.append(f"  <url><loc>{purl.replace('&','&amp;')}</loc><lastmod>{TODAY}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>{img_xml}</url>")

# Collection URLs
for c in coll_data:
    curl = f"{SITE}/collection/?id={c['slug']}"
    url_entries.append(f"  <url><loc>{curl}</loc><lastmod>{TODAY}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>")

# Category URLs (top categories with >= 5 books)
for c in all_cats:
    if c['count'] < 5: continue
    from urllib.parse import quote
    caturl = f"{SITE}/category/?name={quote(c['name'])}"
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

# Sitemap location
Sitemap: {SITE}/sitemap.xml

# Crawl-delay (seconds) — be nice to Google's crawler on this dynamic site
Crawl-delay: 1
"""
robots_out = Path(__file__).parent / "public" / "robots.txt"
robots_out.write_text(robots_txt, encoding="utf-8")
print(f"Generated: {robots_out}")
