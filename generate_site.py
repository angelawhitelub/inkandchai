"""
Generates akshar_co.html — the Akshar & Co. homepage with real book data
embedded from the 99bookstores scrape at ~/InkAndChaiBooks/ALL_BOOKS.json.
"""

import json, re
from pathlib import Path
from collections import Counter, defaultdict

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
        "desc": (b.get("description") or "")[:140],
        "isbn": b.get("isbn", ""),
        "pub":  b.get("publisher", ""),
    })

books_js = json.dumps(slim, ensure_ascii=False)

# ── Real collection cards (top 5 by unique count) ───────────────────────────
cat_counts = Counter(b["category"] for b in books)
TOP_CATS = [
    ("Fiction & Romance",        ["fiction", "all romance books", "romance (on sale)"]),
    ("Self-Help",                ["all self help", "self-help (on sale)", "best self help books from publishers"]),
    ("Kids & Young Adult",       ["kids book", "kids book age: 3-5", "kids book age: 2-6", "kids book age: 5-8", "kids book age: 8-11"]),
    ("Manga & Comics",           ["manga", "comics", "dc comics", "marvel comics"]),
    ("Mythology & Spirituality", ["mythology", "best of spirituality and mythology", "spirituality", "amish tripathi books"]),
]

coll_data = []
for name, cats in TOP_CATS:
    total = sum(cat_counts.get(c.title(), 0) + cat_counts.get(c, 0)
                for c in cats)
    coll_data.append({"name": name, "count": max(total, 1)})

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
<title>Ink & Chai — Books We Love</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=Montserrat:wght@300;400;500&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg: #0d0b08; --bg2: #141210; --bg3: #1c1916;
    --gold: #c9a84c; --gold-light: #e8c97a; --gold-dim: #7a6330;
    --cream: #f0e8d8; --cream-dim: #a09080; --white: #faf7f2;
    --border: rgba(201,168,76,0.18);
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body { background: var(--bg); color: var(--cream); font-family: 'Montserrat', sans-serif; font-weight: 300; overflow-x: hidden; }

  body::before {
    content: ''; position: fixed; inset: 0;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
    pointer-events: none; z-index: 999; opacity: 0.4;
  }

  /* NAV */
  nav { position: fixed; top: 0; left: 0; right: 0; z-index: 100; display: flex; align-items: center; justify-content: space-between; padding: 1.4rem 4rem; background: linear-gradient(to bottom, rgba(13,11,8,0.97) 0%, transparent 100%); border-bottom: 1px solid var(--border); backdrop-filter: blur(12px); }
  .nav-logo { font-family: 'Cormorant Garamond', serif; font-size: 1.5rem; font-weight: 600; letter-spacing: 0.08em; color: var(--gold); text-decoration: none; }
  .nav-logo span { color: var(--cream); font-weight: 300; font-style: italic; }
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
  .hero-right { position: relative; overflow: hidden; }
  .hero-right::before { content: ''; position: absolute; inset: 0; background: linear-gradient(to right, var(--bg) 0%, transparent 30%), linear-gradient(to bottom, transparent 60%, var(--bg) 100%); z-index: 1; }
  .hero-books-grid { position: absolute; inset: 0; display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(4, 1fr); gap: 8px; padding: 80px 40px 40px 20px; transform: rotate(3deg) scale(1.1) translateY(-20px); animation: floatBooks 8s ease-in-out infinite; }
  @keyframes floatBooks { 0%, 100% { transform: rotate(3deg) scale(1.1) translateY(-20px); } 50% { transform: rotate(3deg) scale(1.1) translateY(-32px); } }
  .book-spine { border-radius: 3px; position: relative; overflow: hidden; box-shadow: 4px 4px 20px rgba(0,0,0,0.6), inset -2px 0 6px rgba(0,0,0,0.3); transition: transform 0.3s; }
  .book-spine:hover { transform: scaleY(1.03); }
  .book-spine::after { content: ''; position: absolute; inset: 0; background: linear-gradient(to right, rgba(255,255,255,0.1) 0%, transparent 30%, rgba(0,0,0,0.2) 100%); }
  .b1{background:linear-gradient(135deg,#2c1810,#5a2d1a)}.b2{background:linear-gradient(135deg,#0d2233,#1a4a6b)}.b3{background:linear-gradient(135deg,#1a1a2e,#2d2d5e)}.b4{background:linear-gradient(135deg,#1d3a1d,#2d5a2d)}.b5{background:linear-gradient(135deg,#3a1a0d,#7a3a1a)}.b6{background:linear-gradient(135deg,#2a1a3a,#5a3a7a)}.b7{background:linear-gradient(135deg,#1a2a1a,#3a5a3a)}.b8{background:linear-gradient(135deg,#3a2200,#8a5500)}.b9{background:linear-gradient(135deg,#0a1a2a,#1a3a5a)}.b10{background:linear-gradient(135deg,#2a0a0a,#6a1a1a)}.b11{background:linear-gradient(135deg,#1a2a2a,#3a5a5a)}.b12{background:linear-gradient(135deg,#2a2a0a,#5a5a1a)}

  /* MARQUEE */
  .marquee-bar { background: var(--gold); padding: 0.75rem 0; overflow: hidden; white-space: nowrap; }
  .marquee-track { display: inline-flex; animation: marquee 30s linear infinite; }
  .marquee-item { font-size: 0.6rem; letter-spacing: 0.3em; text-transform: uppercase; color: var(--bg); font-weight: 500; padding: 0 2.5rem; }
  .marquee-dot { color: rgba(13,11,8,0.4); }
  @keyframes marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }

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
  .books-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2rem; }
  .book-card { cursor: pointer; }
  .book-cover { aspect-ratio: 2/3; position: relative; overflow: hidden; margin-bottom: 1.2rem; border: 1px solid var(--border); background: #1a1208; }
  .book-cover img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.5s ease; }
  .book-card:hover .book-cover img { transform: scale(1.05); }
  .book-cover-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.65); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.6rem; opacity: 0; transition: opacity 0.3s; padding: 1rem; }
  .book-card:hover .book-cover-overlay { opacity: 1; }
  .book-cover-title { font-family: 'Cormorant Garamond', serif; font-size: 0.9rem; color: var(--white); text-align: center; line-height: 1.3; }
  .btn-add { font-size: 0.58rem; letter-spacing: 0.22em; text-transform: uppercase; color: var(--bg); background: var(--gold); border: none; padding: 0.7rem 1.4rem; cursor: pointer; font-family: 'Montserrat', sans-serif; font-weight: 500; transition: background 0.3s; }
  .btn-add:hover { background: var(--gold-light); }
  .book-name { font-family: 'Cormorant Garamond', serif; font-size: 1.05rem; font-weight: 400; color: var(--cream); margin-bottom: 0.25rem; line-height: 1.3; }
  .book-author { font-size: 0.62rem; color: var(--cream-dim); letter-spacing: 0.1em; margin-bottom: 0.6rem; }
  .book-meta { display: flex; justify-content: space-between; align-items: baseline; }
  .book-price { font-family: 'Cormorant Garamond', serif; font-size: 1.15rem; color: var(--gold); font-weight: 600; }
  .book-orig-price { font-size: 0.72rem; color: var(--cream-dim); text-decoration: line-through; margin-left: 0.4rem; }
  .book-category { font-size: 0.55rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--gold-dim); }

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
  .cart-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:400; opacity:0; pointer-events:none; transition:opacity 0.35s; }
  .cart-overlay.show { opacity:1; pointer-events:all; }
  .cart-sidebar { position:fixed; top:0; right:0; bottom:0; width:min(420px,100vw); background:var(--bg3); border-left:1px solid var(--border); z-index:500; transform:translateX(100%); transition:transform 0.35s cubic-bezier(0.4,0,0.2,1); display:flex; flex-direction:column; }
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
  .btn-cod-cart { width:100%; font-family:'Montserrat',sans-serif; font-size:0.62rem; letter-spacing:0.18em; text-transform:uppercase; padding:0.85rem; background:transparent; color:var(--cream-dim); border:1px solid var(--border); cursor:pointer; font-weight:300; transition:all 0.3s; }
  .btn-cod-cart:hover { border-color:var(--gold-dim); color:var(--gold); }
  .cart-badge { background:var(--gold); color:var(--bg); border-radius:50%; width:18px; height:18px; font-size:0.55rem; font-weight:500; display:inline-flex; align-items:center; justify-content:center; position:absolute; top:-6px; right:-8px; }
  .nav-cart-wrap { position:relative; }

  /* RESPONSIVE */
  @media (max-width: 1100px) {
    nav { padding: 1.2rem 2rem; }
    .nav-links { display: none; }
    .hero { grid-template-columns: 1fr; }
    .hero-right { display: none; }
    .hero-left { padding: 9rem 2.5rem 5rem; }
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
  }
</style>
</head>
<body>

<nav>
  <a class="nav-logo" href="#">Ink &amp;<span> Chai</span></a>
  <ul class="nav-links">
    <li><a href="#featured">Catalogue</a></li>
    <li><a href="#collections">Collections</a></li>
    <li><a href="#categories">Categories</a></li>
    <li><a href="/terms/">Terms</a></li>
    <li><a href="/privacy-policy/">Privacy</a></li>
    <li><a href="/refund-policy/">Refund</a></li>
    <li><a href="/return-policy/">Returns</a></li>
    <li><a href="/shipping-policy/">Shipping</a></li>
    <li><a href="mailto:support@inkandchai.in">Contact Us</a></li>
  </ul>
  <div class="nav-actions">
    <span class="nav-icon" title="Search" onclick="document.getElementById('searchInput')?.focus();document.getElementById('featured')?.scrollIntoView({behavior:'smooth'})">&#9906;</span>
    <span class="nav-icon" title="Wishlist" onclick="openWishlistModal()">&#9825;<span id="wishBadge" style="display:none;font-size:0.55rem;background:var(--gold);color:var(--bg);border-radius:50%;width:14px;height:14px;display:none;align-items:center;justify-content:center;position:absolute;top:-4px;right:-6px;"></span></span>
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
    <button class="btn-checkout" onclick="openCheckoutForm()">Pay Online →</button>
    <button class="btn-cod-cart" onclick="openCODForm()">🚚 Cash on Delivery</button>
  </div>
</div>

<!-- HERO -->
<section class="hero" style="padding:0;">
  <div class="hero-left">
    <div class="hero-eyebrow">inkandchai.in — Books We Love</div>
    <h1 class="hero-title">Stories that<br/><em>endure</em> the<br/>passage of time.</h1>
    <p class="hero-sub">Curated fiction, non-fiction, poetry, and rare finds — thoughtfully selected for readers who believe in the transformative power of the written word.</p>
    <div class="hero-ctas">
      <a href="#featured" class="btn-primary">Explore Books</a>
      <a href="#collections" class="btn-ghost">View Collections</a>
    </div>
    <div class="hero-stats">
      <div><div class="stat-num" id="stat-total">—</div><div class="stat-label">Titles Available</div></div>
      <div><div class="stat-num">40+</div><div class="stat-label">Genres</div></div>
      <div><div class="stat-num">2-Day</div><div class="stat-label">Pan-India Delivery</div></div>
    </div>
  </div>
  <div class="hero-right">
    <div class="hero-books-grid">
      <div class="book-spine b1" style="grid-row:span 2;"></div>
      <div class="book-spine b2"></div><div class="book-spine b3"></div>
      <div class="book-spine b4" style="grid-row:span 2;"></div>
      <div class="book-spine b5" style="grid-row:span 2;"></div>
      <div class="book-spine b6" style="grid-row:span 2;"></div>
      <div class="book-spine b7"></div><div class="book-spine b8"></div>
      <div class="book-spine b9" style="grid-row:span 2;"></div>
      <div class="book-spine b10" style="grid-row:span 2;"></div>
      <div class="book-spine b11"></div><div class="book-spine b12"></div>
    </div>
  </div>
</section>

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

<!-- FEATURED BOOKS -->
<section class="featured" id="featured">
  <div class="featured-header">
    <div>
      <div class="section-label">Handpicked for You</div>
      <h2 class="section-title">Featured <em>Titles</em></h2>
      <div class="tabs">
        <button class="tab active" data-tab="All"           onclick="setTab(this)">All</button>
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
        <li><a href="#featured">Bestsellers</a></li>
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

function filteredBooks() {
  const q = currentQuery.toLowerCase();
  return BOOKS.filter(b => {
    const tabOk  = currentTab === 'All' || b.tab === currentTab;
    const queryOk = !q || b.t.toLowerCase().includes(q) || (b.a && b.a.toLowerCase().includes(q));
    return tabOk && queryOk;
  });
}

function renderBooks() {
  const books = filteredBooks();
  const slice = books.slice(0, visibleCount);
  const grid  = document.getElementById('booksGrid');

  grid.innerHTML = slice.map((b, i) => {
    const wishlisted = window.isWishlisted ? isWishlisted(b.url) : false;
    const priceNum = parseFloat((b.p||'').replace(/[^0-9.]/g,'')) || 0;
    return `
    <div class="book-card" onclick="location.href='/product/?id=${b.slug}'" style="cursor:pointer;">
      <div class="book-cover" style="position:relative;">
        <img src="${b.img}" alt="${escHtml(b.t)}" loading="lazy"
             onerror="this.style.display='none'" />
        <div class="book-cover-overlay">
          <div class="book-cover-title">${escHtml(b.t)}</div>
          <button class="btn-add" onclick="event.stopPropagation(); addToCartById(this)"
            data-url="${escHtml(b.url)}"
            data-title="${escHtml(b.t)}"
            data-author="${escHtml(b.a||'')}"
            data-price="${priceNum}"
            data-img="${escHtml(b.img)}">Add to Cart</button>
        </div>
        <button class="wish-btn ${wishlisted ? 'wishlisted' : ''}"
          data-url="${escHtml(b.url)}"
          title="${wishlisted ? 'Remove from wishlist' : 'Save to wishlist'}"
          onclick="event.stopPropagation(); if(window.toggleWishlist) toggleWishlist({url:'${escHtml(b.url)}',title:'${escHtml(b.t).replace(/'/g,"\\'")}',img:'${escHtml(b.img)}',price:${priceNum}}); updateWishlistBadge();">
          ${wishlisted ? '♥' : '♡'}
        </button>
      </div>
      <div class="book-name">${escHtml(b.t)}</div>
      <div class="book-author">${escHtml(b.a || '')}</div>
      <div class="book-meta">
        <span class="book-price">${escHtml(b.p)}${b.op ? `<span class="book-orig-price">${escHtml(b.op)}</span>` : ''}</span>
        <span class="book-category">${escHtml(b.cat)}</span>
      </div>
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
    <div class="coll-card ${i === 0 ? 'large' : ''}">
      <div class="coll-inner">
        <div class="coll-bg ${bgClasses[i]}"></div>
        <div class="coll-overlay"></div>
        <div class="coll-content">
          <div class="coll-count">${c.count} Titles</div>
          <div class="coll-name">${escHtml(c.name)}</div>
          <div class="coll-desc">${descs[i]}</div>
        </div>
      </div>
    </div>
  `).join('');
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
    <div class="cat-card ${activeCat === c.name ? 'active-cat' : ''}"
         onclick="selectCat('${c.name.replace(/'/g, "\\'")}')">
      <div class="cat-name">${escHtml(c.name)}</div>
      <div class="cat-count">${c.count} books</div>
    </div>
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
    <div class="book-card" onclick="location.href='/product/?id=${b.slug}'" style="cursor:pointer;">
      <div class="book-cover">
        <img src="${b.img}" alt="${escHtml(b.t)}" loading="lazy" onerror="this.style.display='none'" />
        <div class="book-cover-overlay">
          <div class="book-cover-title">${escHtml(b.t)}</div>
          <button class="btn-add" onclick="event.stopPropagation(); addToCartById(this)"
            data-url="${escHtml(b.url)}"
            data-title="${escHtml(b.t)}"
            data-author="${escHtml(b.a||'')}"
            data-price="${(b.p||'').replace(/[^0-9.]/g,'')}"
            data-img="${escHtml(b.img)}">Add to Cart</button>
        </div>
      </div>
      <div class="book-name">${escHtml(b.t)}</div>
      <div class="book-author">${escHtml(b.a || '')}</div>
      <div class="book-meta">
        <span class="book-price">${escHtml(b.p)}${b.op ? `<span class="book-orig-price">${escHtml(b.op)}</span>` : ''}</span>
        <span class="book-category">${escHtml(b.cat)}</span>
      </div>
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
document.getElementById('stat-total').textContent = BOOKS.length.toLocaleString() + '+';
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
<title>Loading… — Ink &amp; Chai</title>
<meta name="description" content="Buy books online at Ink &amp; Chai — fast pan-India delivery."/>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=Montserrat:wght@300;400;500&display=swap" rel="stylesheet"/>
<style>
:root{--bg:#0d0b08;--bg2:#141210;--bg3:#1c1916;--gold:#c9a84c;--gold-light:#e8c97a;--gold-dim:#7a6330;--cream:#f0e8d8;--cream-dim:#a09080;--white:#faf7f2;--border:rgba(201,168,76,0.18)}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--cream);font-family:'Montserrat',sans-serif;font-weight:300;min-height:100vh}

/* NAV */
nav{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:1.2rem 4rem;background:rgba(13,11,8,0.97);border-bottom:1px solid var(--border);backdrop-filter:blur(12px)}
.nav-logo{font-family:'Cormorant Garamond',serif;font-size:1.5rem;font-weight:600;letter-spacing:0.08em;color:var(--gold);text-decoration:none}
.nav-logo span{color:var(--cream);font-weight:300;font-style:italic}
.nav-back{font-size:0.62rem;letter-spacing:0.2em;text-transform:uppercase;color:var(--cream-dim);text-decoration:none;display:flex;align-items:center;gap:0.5rem;transition:color 0.3s}
.nav-back:hover{color:var(--gold)}
.nav-cart-wrap{position:relative}
.btn-nav{font-family:'Montserrat',sans-serif;font-size:0.62rem;letter-spacing:0.22em;text-transform:uppercase;padding:0.55rem 1.4rem;border:1px solid var(--gold-dim);color:var(--gold);background:transparent;cursor:pointer;transition:all 0.3s;text-decoration:none}
.btn-nav:hover{background:var(--gold);color:var(--bg)}
.cart-badge{background:var(--gold);color:var(--bg);border-radius:50%;width:18px;height:18px;font-size:0.55rem;font-weight:500;display:inline-flex;align-items:center;justify-content:center;position:absolute;top:-6px;right:-8px}

/* PRODUCT LAYOUT */
.product-page{max-width:1100px;margin:0 auto;padding:4rem 2rem 6rem;display:grid;grid-template-columns:1fr 1.4fr;gap:5rem;align-items:start}
@media(max-width:780px){.product-page{grid-template-columns:1fr;gap:2.5rem;padding:2rem 1.2rem 4rem}}

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
.btn-cod{width:100%;font-family:'Montserrat',sans-serif;font-size:0.65rem;letter-spacing:0.25em;text-transform:uppercase;padding:1.1rem;background:transparent;color:var(--cream);border:1px solid var(--border);cursor:pointer;font-weight:400;transition:all 0.3s}
.btn-cod:hover{border-color:var(--gold-dim);color:var(--gold)}
.btn-share{font-size:0.6rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--cream-dim);background:none;border:none;cursor:pointer;display:flex;align-items:center;gap:0.4rem;transition:color 0.2s;font-family:'Montserrat',sans-serif}
.btn-share:hover{color:var(--gold)}

/* RELATED */
.related{max-width:1100px;margin:0 auto;padding:0 2rem 6rem}
.related-title{font-family:'Cormorant Garamond',serif;font-size:1.8rem;font-weight:300;color:var(--white);margin-bottom:2rem}
.related-title em{font-style:italic;color:var(--gold-light)}
.related-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1.5rem}
@media(max-width:780px){.related-grid{grid-template-columns:repeat(2,1fr)}}
.rel-card{cursor:pointer;transition:opacity 0.2s}
.rel-card:hover{opacity:0.85}
.rel-cover{aspect-ratio:2/3;background:var(--bg2);border:1px solid var(--border);overflow:hidden;margin-bottom:0.8rem}
.rel-cover img{width:100%;height:100%;object-fit:cover;display:block}
.rel-title{font-family:'Cormorant Garamond',serif;font-size:0.95rem;color:var(--cream);line-height:1.3;margin-bottom:0.2rem}
.rel-price{font-size:0.85rem;color:var(--gold)}

/* CART SIDEBAR (same as homepage) */
.cart-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:400;opacity:0;pointer-events:none;transition:opacity 0.35s}
.cart-overlay.show{opacity:1;pointer-events:all}
.cart-sidebar{position:fixed;top:0;right:0;bottom:0;width:min(420px,100vw);background:var(--bg3);border-left:1px solid var(--border);z-index:500;transform:translateX(100%);transition:transform 0.35s cubic-bezier(0.4,0,0.2,1);display:flex;flex-direction:column}
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
</style>
</head>
<body>

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
  <a class="nav-logo" href="/">Ink &amp;<span> Chai</span></a>
  <a class="nav-back" href="javascript:history.back()">← Back to catalogue</a>
  <div style="display:flex;gap:1rem;align-items:center;">
    <button class="btn-nav auth-nav-btn" id="authNavBtnProd" onclick="window.IAC ? IAC.openAuthModal() : null">👤 Sign In</button>
    <div class="nav-cart-wrap">
      <button class="btn-nav" onclick="openCart()">Cart</button>
      <span class="cart-badge" id="cartBadge" style="display:none;">0</span>
    </div>
  </div>
</nav>

<!-- PRODUCT CONTENT (rendered by JS) -->
<div id="productContent"></div>
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
    <button class="btn-checkout" onclick="openCheckoutForm()">Pay Online →</button>
    <button class="btn-cod-cart" onclick="openCODForm()">🚚 Cash on Delivery</button>
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

// ── Lookup book by slug ───────────────────────────────────────────────────
const BOOK_MAP = {};
BOOKS.forEach(b => { BOOK_MAP[b.slug] = b; });

function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function pricePaise(priceStr){ return Math.round(parseFloat((priceStr||'').replace(/[^0-9.]/g,'')||0)); }

// ── Render product page ───────────────────────────────────────────────────
function renderProduct(b) {
  document.title = b.t + ' — Buy Online at Ink & Chai';
  // Set meta description
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) metaDesc.content = (b.desc || ('Buy ' + b.t + ' by ' + (b.a||'') + ' online at Ink & Chai. Fast pan-India delivery.'));
  // Set canonical URL (clean slug URL on our domain)
  let canon = document.querySelector('link[rel="canonical"]');
  if (!canon) { canon = document.createElement('link'); canon.rel = 'canonical'; document.head.appendChild(canon); }
  canon.href = 'https://inkandchai.in/product/?id=' + b.slug;

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
            ? `<img src="${esc(b.img)}" alt="${esc(b.t)}" />`
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
          <div class="prod-meta-item"><div class="prod-meta-label">Payment</div><div class="prod-meta-val">UPI · Cards · COD</div></div>
          <div class="prod-meta-item"><div class="prod-meta-label">Sold by</div><div class="prod-meta-val">Ink &amp; Chai</div></div>
        </div>

        <div class="divider"></div>

        <div class="prod-actions">
          <button class="btn-cart" data-slug="${esc(b.slug)}" onclick="addBookToCart(this.dataset.slug)">
            Add to Cart
          </button>
          <button class="btn-cod" data-slug="${esc(b.slug)}" onclick="addBookToCart(this.dataset.slug); openCODForm();">
            🚚 Buy with Cash on Delivery
          </button>
          <button class="btn-share" onclick="shareBook()">
            ↗ Share this book
          </button>
          <button id="prodWishBtn"
            onclick="if(window.toggleWishlist){ toggleWishlist({url:'${esc(b.url)}',title:'${esc(b.t).replace(/'/g,'\\u0027')}',img:'${esc(b.img)}',price:${sale}}); updateProdWishBtn(); }"
            style="font-family:'Montserrat',sans-serif;font-size:0.62rem;letter-spacing:0.2em;text-transform:uppercase;
                   padding:0.7rem 1.4rem;border:1px solid rgba(201,168,76,0.3);color:#a09080;
                   background:transparent;cursor:pointer;margin-top:0.4rem;transition:all 0.2s;"
            title="Save to wishlist">
            ♡ Save to Wishlist
          </button>
        </div>
      </div>
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
function addBookToCart(bookSlug) {
  const b = BOOK_MAP[bookSlug];
  if (!b) return;
  const price = parseFloat((b.p||'').replace(/[^0-9.]/g,'')) || 0;
  addToCart({ id: b.url || bookSlug, title: b.t, author: b.a||'', price, img: b.img||'', url: b.url||'' });
}

// ── Init ──────────────────────────────────────────────────────────────────
const params  = new URLSearchParams(window.location.search);
const slug    = params.get('id');
const book    = slug ? BOOK_MAP[slug] : null;

if (book) {
  renderProduct(book);
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

PRODUCT_HTML = PRODUCT_HTML.replace("BOOKS_DATA_PLACEHOLDER",        books_js)
PRODUCT_HTML = PRODUCT_HTML.replace("RAZORPAY_PUB_KEY_PLACEHOLDER",  razorpay_key)
PRODUCT_HTML = PRODUCT_HTML.replace("SUPABASE_URL_PLACEHOLDER",      os.environ.get("SUPABASE_URL", ""))
PRODUCT_HTML = PRODUCT_HTML.replace("SUPABASE_ANON_KEY_PLACEHOLDER", os.environ.get("SUPABASE_ANON_KEY", ""))

prod_out = Path(__file__).parent / "public" / "product" / "index.html"
prod_out.parent.mkdir(parents=True, exist_ok=True)
prod_out.write_text(PRODUCT_HTML, encoding="utf-8")
print(f"Generated: {prod_out}  ({len(PRODUCT_HTML.encode())//1024} KB)")
print(f"Books embedded: {len(slim)}")

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

    desc = xml_escape(b.get("desc") or b.get("t") or "")
    if not desc:
        desc = f"Buy {xml_escape(b.get('t',''))} by {xml_escape(b.get('a',''))} online."

    items.append(f"""    <item>
      <g:id>{xml_escape(slug)}</g:id>
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
    <description>Buy books online at Ink &amp; Chai. Pan-India delivery. Cash on Delivery available.</description>
{chr(10).join(items)}
  </channel>
</rss>"""

feed_out = Path(__file__).parent / "public" / "feed.xml"
feed_out.write_text(feed_xml, encoding="utf-8")
print(f"Generated: {feed_out}  ({len(feed_xml.encode())//1024} KB, {len(items)} products)")
