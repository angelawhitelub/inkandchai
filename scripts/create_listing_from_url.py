#!/usr/bin/env python3
"""Create an SEO-ready Ink & Chai product listing from an Amazon book URL.

The script intentionally never imports or uploads a cover image. Amazon pages
occasionally block automated requests, so metadata is supplemented from Google
Books using the ISBN/ASIN embedded in the URL.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import ssl
import subprocess
import sys
from html.parser import HTMLParser
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote_plus, urlparse
from urllib.request import Request, urlopen


DEFAULT_SITE = "https://inkandchai.in"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
)


def ssl_context() -> ssl.SSLContext:
    """Use certifi when macOS Python has no configured OpenSSL CA bundle."""
    try:
        import certifi  # type: ignore

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


class MetadataParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.meta: dict[str, str] = {}
        self.json_ld: list[dict[str, Any]] = []
        self._json_depth = 0
        self._json_chunks: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {k.lower(): v or "" for k, v in attrs}
        if tag.lower() == "meta":
            key = (values.get("property") or values.get("name") or "").lower()
            if key and values.get("content"):
                self.meta[key] = values["content"].strip()
        if tag.lower() == "script" and values.get("type", "").lower() == "application/ld+json":
            self._json_depth += 1
            self._json_chunks = []

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() != "script" or not self._json_depth:
            return
        self._json_depth = 0
        raw = "".join(self._json_chunks).strip()
        try:
            parsed = json.loads(raw)
            candidates = parsed if isinstance(parsed, list) else [parsed]
            self.json_ld.extend(item for item in candidates if isinstance(item, dict))
        except (TypeError, json.JSONDecodeError):
            pass
        self._json_chunks = []

    def handle_data(self, data: str) -> None:
        if self._json_depth:
            self._json_chunks.append(data)


def fetch_json(url: str) -> dict[str, Any]:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urlopen(request, timeout=20, context=ssl_context()) as response:
        return json.load(response)


def fetch_html(url: str) -> str:
    request = Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept-Language": "en-IN,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml",
        },
    )
    with urlopen(request, timeout=20, context=ssl_context()) as response:
        return response.read().decode(response.headers.get_content_charset() or "utf-8", "replace")


def clean(value: Any) -> str:
    if isinstance(value, list):
        value = ", ".join(clean(item) for item in value if clean(item))
    if isinstance(value, dict):
        value = value.get("name", "")
    return re.sub(r"\s+", " ", html.unescape(str(value or ""))).strip()


def strip_html(value: Any) -> str:
    return clean(re.sub(r"<[^>]+>", " ", str(value or "")))


def isbn_from_url(url: str) -> str:
    match = re.search(r"/(?:dp|gp/product)/([0-9X]{10}|[0-9]{13})(?:[/?]|$)", url, re.I)
    return match.group(1).upper() if match else ""


def slugify(value: str) -> str:
    value = value.lower().encode("ascii", "ignore").decode()
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", value))[:80]


def author_names(value: Any) -> str:
    if not value:
        return ""
    values = value if isinstance(value, list) else [value]
    return ", ".join(filter(None, (clean(item) for item in values)))


def amazon_metadata(url: str) -> dict[str, Any]:
    try:
        parser = MetadataParser()
        parser.feed(fetch_html(url))
    except (HTTPError, URLError, TimeoutError):
        return {}

    product: dict[str, Any] = {}
    for item in parser.json_ld:
        graph = item.get("@graph", []) if isinstance(item.get("@graph"), list) else []
        for candidate in [item, *graph]:
            kind = candidate.get("@type") if isinstance(candidate, dict) else ""
            if kind in ("Book", "Product") or (isinstance(kind, list) and "Product" in kind):
                product = candidate
                break
        if product:
            break

    return {
        "title": clean(product.get("name") or parser.meta.get("og:title", "")).split(" : Amazon.in:")[0],
        "authors": author_names(product.get("author")),
        "description": strip_html(product.get("description") or parser.meta.get("description", "")),
        "isbn": clean(product.get("isbn")),
        "publisher": clean(product.get("publisher")),
    }


def google_books_metadata(isbn: str) -> dict[str, Any]:
    if not isbn:
        return {}
    try:
        data = fetch_json(f"https://www.googleapis.com/books/v1/volumes?q=isbn:{quote_plus(isbn)}&maxResults=1")
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError):
        return {}
    items = data.get("items") or []
    if not items:
        return {}
    info = items[0].get("volumeInfo") or {}
    identifiers = info.get("industryIdentifiers") or []
    isbn13 = next((item.get("identifier") for item in identifiers if item.get("type") == "ISBN_13"), "")
    return {
        "title": clean(info.get("title")),
        "subtitle": clean(info.get("subtitle")),
        "authors": author_names(info.get("authors")),
        "description": strip_html(info.get("description")),
        "publisher": clean(info.get("publisher")),
        "isbn": clean(isbn13 or isbn),
        "pages": info.get("pageCount"),
        "language": clean(info.get("language", "en")),
        "categories": info.get("categories") or [],
    }


def open_library_metadata(isbn: str) -> dict[str, Any]:
    """Fallback when Amazon blocks bots or the Google Books quota is exhausted."""
    if not isbn:
        return {}
    key = f"ISBN:{isbn}"
    try:
        data = fetch_json(
            "https://openlibrary.org/api/books?bibkeys="
            f"{quote_plus(key)}&jscmd=data&format=json"
        )
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError):
        return {}
    info = data.get(key) or {}
    return {
        "title": clean(info.get("title")),
        "subtitle": clean(info.get("subtitle")),
        "authors": author_names(info.get("authors")),
        "description": strip_html(info.get("notes") or info.get("excerpts")),
        "publisher": author_names(info.get("publishers")),
        "isbn": isbn,
        "pages": info.get("number_of_pages"),
        "language": "en",
        "categories": [clean(item) for item in info.get("subjects") or [] if clean(item)],
    }


def netlify_admin_secret() -> str:
    try:
        result = subprocess.run(
            ["netlify", "env:get", "ADMIN_SECRET"],
            check=True,
            capture_output=True,
            text=True,
            timeout=20,
        )
        return result.stdout.strip()
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return ""


def choose(*values: Any) -> Any:
    return next((value for value in values if value not in (None, "", [])), "")


def truncate(value: str, limit: int) -> str:
    value = clean(value)
    return value if len(value) <= limit else value[: limit - 1].rstrip(" ,;:-") + "…"


def build_payload(args: argparse.Namespace) -> dict[str, Any]:
    asin = isbn_from_url(args.url)
    amazon = amazon_metadata(args.url)
    lookup_isbn = choose(amazon.get("isbn"), asin)
    books = google_books_metadata(lookup_isbn)
    fallback = open_library_metadata(lookup_isbn)
    for key, value in fallback.items():
        if books.get(key) in (None, "", []):
            books[key] = value

    title = clean(choose(args.title, amazon.get("title"), books.get("title")))
    subtitle = clean(choose(args.subtitle, books.get("subtitle")))
    if subtitle and subtitle.lower() not in title.lower():
        title = f"{title}: {subtitle}"
    authors = clean(choose(args.authors, amazon.get("authors"), books.get("authors")))
    if not title or not authors:
        raise ValueError("Could not resolve title/authors. Pass --title and --authors to continue.")

    isbn = clean(choose(args.isbn, books.get("isbn"), amazon.get("isbn"), asin))
    publisher = clean(choose(args.publisher, amazon.get("publisher"), books.get("publisher")))
    category = clean(choose(args.category, (books.get("categories") or [""])[0], "Business & Economics"))
    pages = books.get("pages")
    source_description = clean(choose(args.description, amazon.get("description"), books.get("description")))
    if not source_description:
        source_description = (
            f"Discover {title}, a practical paperback for readers interested in {category.lower()}. "
            "Order online from Ink & Chai with secure checkout and pan-India delivery."
        )
    details = ["Format: Paperback"]
    if publisher:
        details.append(f"Publisher: {publisher}")
    details.append("Language: English")
    if pages:
        details.append(f"Pages: {pages}")
    if isbn:
        details.append(f"ISBN: {isbn}")
    description = (
        f"Buy {title} by {authors} in paperback from Ink & Chai. {source_description}\n\n"
        + "\n".join(details)
    )[:5000].strip()
    short_title = title.split(":", 1)[0].strip()
    seo_authors = authors.replace(" and ", " & ")
    seo_title = truncate(f"Buy {short_title} Paperback by {seo_authors} | ₹{args.price:g}", 68)
    meta_description = truncate(
        f"Buy {short_title} paperback by {authors} for ₹{args.price:g} at Ink & Chai. "
        "Fast pan-India delivery, secure payments and COD available.",
        158,
    )
    tags = ", ".join(filter(None, [
        "paperback", "business books", "strategy", "entrepreneurship",
        "category design", *[clean(item).lower() for item in books.get("categories") or []],
    ]))

    return {
        "slug": slugify(args.slug or f"{title}-{authors}"),
        "title": title,
        "author": authors,
        "category": category,
        "description": description,
        "price_inr": args.price,
        "original_price_inr": args.mrp,
        "image_url": "",
        "gallery_images": [],
        "publisher": publisher,
        "isbn": isbn,
        "seo_title": seo_title,
        "meta_description": meta_description,
        "tags": truncate(tags, 700),
        "is_active": True,
    }


def publish(payload: dict[str, Any], endpoint: str, secret: str) -> dict[str, Any]:
    request = Request(
        endpoint,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "X-Admin-Key": secret},
    )
    try:
        with urlopen(request, timeout=30, context=ssl_context()) as response:
            return json.load(response)
    except HTTPError as exc:
        message = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"Listing API returned HTTP {exc.code}: {message}") from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="Amazon book product URL")
    parser.add_argument("--price", type=float, default=299, help="Sale price in INR (default: 299)")
    parser.add_argument("--mrp", type=float, default=None, help="Optional MRP in INR")
    parser.add_argument("--title", help="Override detected title")
    parser.add_argument("--subtitle", help="Override/add subtitle")
    parser.add_argument("--authors", help="Override detected authors")
    parser.add_argument("--publisher", help="Override detected publisher")
    parser.add_argument("--isbn", help="Override detected ISBN")
    parser.add_argument("--category", help="Override detected category")
    parser.add_argument("--description", help="Override source description")
    parser.add_argument("--slug", help="Override generated URL slug")
    parser.add_argument("--site", default=os.getenv("INKANDCHAI_SITE_URL", DEFAULT_SITE))
    parser.add_argument("--admin-key", default=os.getenv("INKANDCHAI_ADMIN_SECRET", ""))
    parser.add_argument("--dry-run", action="store_true", help="Print payload without publishing")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if urlparse(args.url).scheme not in ("http", "https"):
        print("error: URL must start with http:// or https://", file=sys.stderr)
        return 2
    try:
        payload = build_payload(args)
        if args.dry_run:
            print(json.dumps(payload, indent=2, ensure_ascii=False))
            return 0
        secret = args.admin_key or netlify_admin_secret()
        if not secret:
            raise RuntimeError(
                "Admin credential unavailable. Set INKANDCHAI_ADMIN_SECRET, pass --admin-key, "
                "or run from the linked Netlify repository."
            )
        endpoint = args.site.rstrip("/") + "/.netlify/functions/create-product-listing"
        result = publish(payload, endpoint, secret)
        product_url = args.site.rstrip("/") + result["url"]
        print(f"Created: {product_url}")
        print(f"Cover: intentionally blank (upload it in Admin → Products & Prices)")
        return 0
    except (ValueError, RuntimeError, HTTPError, URLError, TimeoutError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
