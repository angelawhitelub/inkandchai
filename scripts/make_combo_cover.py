#!/usr/bin/env python3
"""
make_combo_cover.py — build a combo product image out of the covers it contains.

WHY THIS EXISTS
  A combo listing sells two or more books, but until now its picture was one
  book: create-a-listing takes a single image, so every combo either reused a
  component's cover -- which shows the customer one of the books they are
  paying for -- or waited on somebody hand-building a mockup in Canva. That
  hand step is why 308 of the 357 combos on the site have never sold a unit and
  why obvious pairs were never listed at all.

  We already hold a flat cover for all 5,096 books. This composes them: each
  cover is given a spine and a slight turn so it reads as a physical book, then
  the set is stood on a white ground with a soft contact shadow, matching the
  mockups already used for the combos that do sell.

  Deliberately not a 3-D render. We have the front cover and nothing else -- no
  spine artwork, no back -- so the spine here is built from the cover's own left
  edge. At the size these appear on a product card the effect is convincing;
  invented spine text would not be.

USAGE
  python3 scripts/make_combo_cover.py out.webp <cover-url-or-path> ...
"""
import io
import os
import ssl
import sys
import urllib.request

from PIL import Image, ImageFilter

CANVAS = 1254               # square, matching the existing combo images
MARGIN_X = 84
BASELINE = 0.80             # where the books stand, as a fraction of the canvas
SPINE_RATIO = 0.085         # spine width as a fraction of the cover width
TURN = 0.030                # how much the far edge shortens, giving the turn
BG = (255, 255, 255)

_UA = {'User-Agent': 'Mozilla/5.0 (compatible; inkandchai-combo-image/1.0)'}


def _ssl_context():
    """python.org builds ship no system roots, so trust certifi when it is here."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def load_cover(src):
    """Fetch a cover from a URL, a /images/... site path, or a local file."""
    if src.startswith('http'):
        req = urllib.request.Request(src, headers=_UA)
        with urllib.request.urlopen(req, timeout=30, context=_ssl_context()) as r:
            data = r.read()
        return Image.open(io.BytesIO(data)).convert('RGB')
    path = src
    if src.startswith('/'):
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'public', src.lstrip('/'))
    return Image.open(path).convert('RGB')


def trim_white(im, tol=248):
    """Drop the white margin publishers' scans carry, so covers stand equal.

    Without this a cover with 12% padding renders as a visibly shorter book
    beside one that was cropped tight, and the row looks broken rather than
    stylised.
    """
    gray = im.convert('L')
    mask = gray.point(lambda p: 255 if p < tol else 0)
    box = mask.getbbox()
    if not box:
        return im
    w, h = im.size
    # Refuse absurd crops: a mostly-white cover would otherwise be cropped to
    # its title text.
    if (box[2] - box[0]) < w * 0.5 or (box[3] - box[1]) < h * 0.5:
        return im
    pad = 2
    return im.crop((max(0, box[0] - pad), max(0, box[1] - pad),
                    min(w, box[2] + pad), min(h, box[3] + pad)))


def _perspective_coeffs(dst, src):
    """Coefficients mapping dst quad -> src quad for Image.PERSPECTIVE."""
    import numpy as np
    a = []
    b = []
    for (dx, dy), (sx, sy) in zip(dst, src):
        a.append([dx, dy, 1, 0, 0, 0, -sx * dx, -sx * dy])
        a.append([0, 0, 0, dx, dy, 1, -sy * dx, -sy * dy])
        b += [sx, sy]
    res = np.linalg.solve(np.array(a, dtype=float), np.array(b, dtype=float))
    return res.tolist()


def book(cover, height):
    """Render one standing book: spine, turned front cover, edge highlight.

    Returns an RGBA image whose bottom edge is the point the book stands on.
    """
    cover = trim_white(cover)
    cw = int(height / 1.5)
    spine_w = max(6, int(cw * SPINE_RATIO))
    turn = int(height * TURN)
    w = spine_w + cw
    h = height + turn

    face = cover.resize((cw, height), Image.LANCZOS)
    # The front cover is turned a few degrees: its far (right) edge sits lower
    # and shorter than the near edge, which is what sells the third dimension.
    dst = [(0, turn), (cw, 0), (cw, height), (0, height + turn)]
    src = [(0, 0), (cw, 0), (cw, height), (0, height)]
    face_t = face.transform((cw, h), Image.PERSPECTIVE,
                            _perspective_coeffs(dst, src), Image.BICUBIC)
    face_mask = Image.new('L', (cw, height), 255).transform(
        (cw, h), Image.PERSPECTIVE, _perspective_coeffs(dst, src), Image.BICUBIC)

    # The spine is a flat panel in the cover's own edge colour, shaded darker
    # towards the fold. An earlier version squeezed the cover's leftmost pixels
    # into the spine, which on a text-heavy cover dragged half-letters down the
    # side and read as a printing fault. We do not have the real spine artwork,
    # so the spine says nothing rather than something wrong.
    edge = cover.crop((0, 0, max(1, int(cover.width * 0.04)), cover.height))
    r, g, b = edge.resize((1, 1), Image.LANCZOS).getpixel((0, 0))
    strip = Image.new('RGB', (spine_w, height))
    px = strip.load()
    for sx in range(spine_w):
        # Darkest at the fold (left), lifting towards the cover, so the spine
        # turns rather than sitting flat.
        k = 0.55 + 0.30 * (sx / max(1, spine_w - 1))
        col = (int(r * k), int(g * k), int(b * k))
        for sy in range(height):
            px[sx, sy] = col
    sdst = [(0, 0), (spine_w, turn), (spine_w, height + turn), (0, height)]
    ssrc = [(0, 0), (spine_w, 0), (spine_w, height), (0, height)]
    spine_t = strip.transform((spine_w, h), Image.PERSPECTIVE,
                              _perspective_coeffs(sdst, ssrc), Image.BICUBIC)
    spine_mask = Image.new('L', (spine_w, height), 255).transform(
        (spine_w, h), Image.PERSPECTIVE, _perspective_coeffs(sdst, ssrc), Image.BICUBIC)

    out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    out.paste(spine_t, (0, 0), spine_mask)
    out.paste(face_t, (spine_w, 0), face_mask)
    return out


def compose(covers, out_path):
    n = len(covers)
    if not n:
        raise ValueError('a combo image needs at least one cover')
    canvas = Image.new('RGB', (CANVAS, CANVAS), BG)

    # More books means smaller books, so a set of six still fits the same square
    # a pair does and every combo card on the site looks like a set. Pairs get
    # room to breathe; larger sets close ranks, the way a boxed set is shot,
    # because spacing four books like two leaves them stranded in white.
    gap = 44 if n <= 2 else (26 if n == 3 else 14)
    margin = MARGIN_X if n <= 2 else 56
    avail = CANVAS - 2 * margin - gap * (n - 1)
    bw = avail / n
    height = min(int(bw * 1.5 / (1 + SPINE_RATIO)), int(CANVAS * 0.72))

    books = [book(c, height) for c in covers]
    total = sum(b.width for b in books) + gap * (n - 1)
    x = (CANVAS - total) // 2
    # Stand the row on a baseline that keeps it optically centred: a fixed
    # baseline leaves a four-book row hugging the bottom of the square.
    row_h = max(b.height for b in books)
    base = (CANVAS + row_h) // 2 + int(CANVAS * 0.02)

    # One shadow layer for the whole row, blurred once: per-book shadows pasted
    # separately overlap into dark seams where books sit close together.
    shadow = Image.new('L', (CANVAS, CANVAS), 0)
    for b in books:
        y = base - b.height
        ell = Image.new('L', (b.width, int(height * 0.055)), 0)
        from PIL import ImageDraw
        ImageDraw.Draw(ell).ellipse((0, 0, b.width - 1, ell.height - 1), fill=165)
        shadow.paste(ell, (x, base - ell.height // 2), ell)
        x += b.width + gap
    shadow = shadow.filter(ImageFilter.GaussianBlur(16))
    canvas.paste(Image.new('RGB', (CANVAS, CANVAS), (108, 110, 116)), (0, 0), shadow)

    x = (CANVAS - total) // 2
    for b in books:
        canvas.paste(b, (x, base - b.height), b)
        x += b.width + gap

    canvas.save(out_path, 'WEBP', quality=88, method=6)
    return out_path


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__.strip().splitlines()[-1])
        raise SystemExit(2)
    dest, sources = sys.argv[1], sys.argv[2:]
    compose([load_cover(s) for s in sources], dest)
    print(dest)
