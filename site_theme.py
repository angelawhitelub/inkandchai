"""Site theme: one type system, one pill shape, one palette on every page.

The storefront's look had grown in layers: six font families (Fraunces,
Cormorant, Lora, Inter, Montserrat, Cinzel), labels set at 8-10px in tracked
capitals, and about 150 pages that were dark-only while the homepage and product
pages default to light. site_theme.css is the final layer that settles all of
that. It is loaded last in <head> on every page outside /admin/, so it wins
without anyone having to rewrite the per-page styles underneath it.

Two ways in:
  * generate_site.py calls apply_to_tree() as its last pass;
  * `python3 site_theme.py` applies it to the pages already in public/, for a
    theme change that should not wait on (or risk) a full rebuild.

The same fenced block also loads public/js/site-feedback.js, the 5-star
"how was the website / how was ordering" card, because it has to reach exactly
the same set of pages.

Everything this writes into a page sits inside an IAC-THEME fence and is
stripped before it is written again, so re-running is always safe.
"""
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent
CSS_SOURCE = ROOT / "site_theme.css"
SKIP_DIRS = {"admin"}

FONTS_URL = (
    "https://fonts.googleapis.com/css2?"
    "family=DM+Serif+Display:ital@0;1"
    "&family=Plus+Jakarta+Sans:wght@400;500;600;700;800"
    "&display=swap"
)

_OPEN, _CLOSE = "<!--IAC-THEME-->", "<!--/IAC-THEME-->"
_fence_re = re.compile(re.escape(_OPEN) + r".*?" + re.escape(_CLOSE) + r"\n?", re.S)
_html_tag_re = re.compile(r"<html\b[^>]*>", re.I)

# Pages that carry the light/dark switch have this in their bootstrap script.
# Pages without it were dark-only; they now follow the site default, light.
_THEME_SWITCH_MARK = "iac_theme"

# The nav buttons carried emoji as icons; the stylesheet draws real ones.
_LABEL_FIXES = (
    ('>📦 My Orders</button>', '>My Orders</button>'),
    ('<button class="btn-nav" onclick="window.IAC ? IAC.openMyOrders() : null"',
     '<button class="btn-nav orders-nav-btn" onclick="window.IAC ? IAC.openMyOrders() : null"'),
    ('>👤 Sign In</button>', '>Sign In</button>'),
    ("btn.textContent = '👤 ' + ", "btn.textContent = "),
)


def write_css(public_dir: Path) -> str:
    """Write the content-hashed stylesheet, sweep old hashes, return its URL."""
    css = CSS_SOURCE.read_text(encoding="utf-8")
    name = f"theme-{hashlib.md5(css.encode()).hexdigest()[:8]}.css"
    css_dir = public_dir / "css"
    css_dir.mkdir(parents=True, exist_ok=True)
    for old in css_dir.glob("theme-*.css"):
        if old.name != name:
            old.unlink(missing_ok=True)
    (css_dir / name).write_text(css, encoding="utf-8")
    return f"/css/{name}"


def theme_tag(href: str) -> str:
    return (
        _OPEN
        + '<link rel="preconnect" href="https://fonts.googleapis.com"/>'
        + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>'
        + f'<link rel="stylesheet" href="{FONTS_URL}"/>'
        + f'<link rel="stylesheet" href="{href}"/>'
        + '<script src="/js/site-feedback.js" defer></script>'
        + _CLOSE
    )


def apply(html: str, tag: str) -> str:
    """Return html with the theme applied. Idempotent."""
    if "</head>" not in html:
        return html
    html = _fence_re.sub("", html)
    for old, new in _LABEL_FIXES:
        html = html.replace(old, new)
    if _THEME_SWITCH_MARK not in html:
        m = _html_tag_re.search(html)
        if m and "iac-light" not in m.group(0):
            tag_open = m.group(0)
            if re.search(r'\bclass="', tag_open):
                new_open = re.sub(r'\bclass="', 'class="iac-light ', tag_open, count=1)
            else:
                new_open = tag_open[:-1].rstrip() + ' class="iac-light">'
            html = html[:m.start()] + new_open + html[m.end():]
    # Last thing in <head>, so it is the final word over every inline <style>.
    idx = html.find("</head>")
    return html[:idx] + tag + "\n" + html[idx:]


def apply_to_tree(public_dir: Path) -> int:
    tag = theme_tag(write_css(public_dir))
    changed = 0
    for page in sorted(public_dir.rglob("*.html")):
        if SKIP_DIRS.intersection(page.relative_to(public_dir).parts):
            continue
        before = page.read_text(encoding="utf-8")
        after = apply(before, tag)
        if after != before:
            page.write_text(after, encoding="utf-8")
            changed += 1
    return changed


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "public"
    print(f"Site theme applied to {apply_to_tree(target)} pages")
