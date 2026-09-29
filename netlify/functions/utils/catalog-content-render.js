/**
 * What an admin-written description does to a baked catalogue page.
 *
 * Catalogue books are static files generated from data/ALL_BOOKS.json, so
 * nothing saved in the admin reaches them until the site is regenerated. The
 * Worker closes that gap: for a slug in the catalog_content table (mirrored to
 * KV by utils/catalog-content.js) it rewrites the page as it is served --
 * <title>, the meta and og descriptions, "About this book", an "About the
 * author" block, and the description/keywords in the Book JSON-LD.
 *
 * This file is the pure part (text in, strings out), so it is unit-tested and
 * the Worker only does the HTMLRewriter plumbing. Formatting uses the same
 * utils/rich-text.js the custom product pages use, which escapes everything
 * before adding its own tags -- admin copy can never inject markup.
 */

'use strict';

const { richText, plainText } = require('./rich-text');

// Same rules custom product pages get (product-page.js); the baked template
// has no .rich styles of its own.
const RICH_CSS = '<style id="iac-catalog-content">'
  + '.desc.rich{font-family:Lora,Georgia,serif}.rich p{margin:0 0 .85rem}.rich p:last-child{margin-bottom:0}'
  + '.rich strong{font-weight:700}.rich em{font-style:italic}'
  + '.rich h3{margin:1.15rem 0 .5rem;font-size:.95rem;font-weight:600;letter-spacing:.01em}.rich h3:first-of-type{margin-top:0}'
  + '.rich ul{margin:0 0 .85rem;padding-left:1.15rem}.rich li{margin:.3rem 0}.authorbio p:first-of-type{margin-top:0}'
  + '</style>';

function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–—-]+$/, '') + '…';
}

// Attribute values: HTMLRewriter's setAttribute takes the value as-is, so a
// double quote would end the attribute. Swap it rather than escape it -- an
// entity would be escaped a second time if the runtime ever starts escaping.
const attr = (s) => String(s || '').replace(/"/g, '”');

/**
 * @param {object} entry  { description, author_bio, seo_title, meta_description, tags }
 * @returns {null | { title, meta, descHtml, bioHtml, ldDescription, keywords }}
 *          null fields are left as the baked page has them.
 */
function contentRewrite(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const description = String(entry.description || '').trim();
  const bio = String(entry.author_bio || '').trim();
  const seoTitle = String(entry.seo_title || '').trim();
  const metaIn = String(entry.meta_description || '').trim();
  const tags = String(entry.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  if (!description && !bio && !seoTitle && !metaIn && !tags.length) return null;
  const meta = metaIn ? clip(metaIn, 320) : description ? clip(plainText(description), 155) : '';
  return {
    title: seoTitle ? clip(seoTitle, 150) : null,
    meta: meta ? attr(meta) : null,
    descHtml: description ? richText(description) : null,
    bioHtml: bio ? richText(bio) : null,
    ldDescription: description ? clip(plainText(description), 5000) : null,
    keywords: tags.length ? tags.join(', ') : null,
  };
}

/**
 * Patch one JSON-LD block. Only the Book/Product one is touched; anything that
 * does not parse, or is another type, comes back null (leave it alone).
 */
function patchJsonLd(text, rw) {
  if (!rw || (!rw.ldDescription && !rw.keywords)) return null;
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  const types = [].concat(doc && doc['@type'] || []).map(String);
  if (!types.some((t) => t === 'Book' || t === 'Product')) return null;
  if (rw.ldDescription) doc.description = rw.ldDescription;
  if (rw.keywords) doc.keywords = rw.keywords;
  // "</script>" inside a string would end the script element.
  return JSON.stringify(doc).replace(/</g, '\\u003c');
}

/** "About this book" inner HTML, keeping the baked label. */
function descInner(rw) {
  return `<div class="label">About this book</div>${rw.descHtml}`;
}

function bioBlock(rw) {
  return `<div class="desc rich authorbio"><div class="label">About the author</div>${rw.bioHtml}</div>`;
}

module.exports = { contentRewrite, patchJsonLd, descInner, bioBlock, RICH_CSS, clip };
