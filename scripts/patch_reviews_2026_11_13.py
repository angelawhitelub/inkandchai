"""One-off patch of baked product pages (13 Nov 2026, owner: "only real reviews").

generate_site.py now builds pages this way; baked pages are never regenerated
locally, so this applies the same change to public/product/*/index.html:
  - drop the stored rating line ("4.8 rating · 14 customer reviews")
  - drop the stored "Reader reviews · Trusted by readers across India" box,
    keeping any customer photos/videos as "Customer photos"
  - drop the stored review cards (catalogue `reviews` lists)
  - drop aggregateRating / review from the JSON-LD
  - swap the inline live-reviews block for /js/reviews.js
Usage: python3 scripts/patch_reviews_2026_11_13.py [--write]
"""
import glob, html, json, re, sys

WRITE = "--write" in sys.argv
REV = "20261113"
RATING_LINE = re.compile(r'<div class="rating-line"><span class="stars">★★★★★</span><span>[^<]*customer reviews</span></div>')
READER_BOX = re.compile(r'<section class="reviews"><div class="review-head"><div><div class="label">Reader reviews</div>.*?</section>', re.S)
MEDIA = re.compile(r'<div class="review-media">.*?</div>(?=<p>Readers choose)', re.S)
CARDS = re.compile(r'<section style="max-width:1260px;margin:1\.5rem auto 0;padding:0 1rem"><div style="border-top:1px solid var\(--border\);padding-top:1\.6rem"><div style="display:flex;align-items:baseline;gap:\.7rem;margin-bottom:1\.1rem;flex-wrap:wrap"><h2[^>]*>Customer Reviews</h2>.*?</div></div></section>', re.S)
LIVE = re.compile(r'<section class="reviews" id="liveReviews" style="display:none">.*?var S = ("(?:[^"\\]|\\.)*");.*?</script>', re.S)
LD = re.compile(r'(<script type="application/ld\+json">)(.*?)(</script>)', re.S)

def strip_ratings(node):
    changed = False
    if isinstance(node, dict):
        for k in ("aggregateRating", "review"):
            if k in node:
                del node[k]; changed = True
        for v in node.values():
            changed |= strip_ratings(v)
    elif isinstance(node, list):
        for v in node:
            changed |= strip_ratings(v)
    return changed

def patch(s):
    stats = {}
    s, n = RATING_LINE.subn("", s); stats["rating_line"] = n
    def box(m):
        mm = MEDIA.search(m.group(0))
        media = mm.group(0) if mm and "<figure" in mm.group(0) else ""
        return f'<section class="reviews"><div class="label">Customer photos</div>{media}</section>' if media else ""
    s, n = READER_BOX.subn(box, s); stats["reader_box"] = n
    s, n = CARDS.subn("", s); stats["cards"] = n
    def live(m):
        slug = json.loads(m.group(1))
        return (f'<section id="liveReviews" data-slug="{html.escape(slug, quote=True)}" hidden></section>'
                f'<script src="/js/reviews.js?v={REV}" defer></script>')
    s, n = LIVE.subn(live, s); stats["live"] = n
    ld_n = 0
    def ld(m):
        nonlocal ld_n
        raw = m.group(2)
        if "aggregateRating" not in raw and '"review"' not in raw:
            return m.group(0)
        try:
            data = json.loads(raw.replace("<\\/", "</"))
        except ValueError:
            return m.group(0)
        if not strip_ratings(data):
            return m.group(0)
        ld_n += 1
        return m.group(1) + json.dumps(data, ensure_ascii=False).replace("</", "<\\/") + m.group(3)
    s = LD.sub(ld, s); stats["ld"] = ld_n
    return s, stats

if __name__ == "__main__":
    total = {}
    files = [f for f in glob.glob("public/product/*/index.html")]
    touched = 0
    for f in files:
        src = open(f, encoding="utf-8").read()
        out, st = patch(src)
        for k, v in st.items():
            total[k] = total.get(k, 0) + (1 if v else 0)
        if out != src:
            touched += 1
            if WRITE:
                open(f, "w", encoding="utf-8").write(out)
    print(("WROTE" if WRITE else "DRY RUN"), len(files), "pages,", touched, "changed; pages per change:", total)
