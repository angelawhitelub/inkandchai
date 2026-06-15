/**
 * build-kawaii-feed.js
 * Generates a Google Merchant Center product feed for the Kawaii Corner
 * (Inkarto stationery) catalogue → public/kawaii/feed.xml
 *
 * Kawaii products live in public/kawaii/products.js as `const PRODUCTS = [...]`
 * (separate from ALL_BOOKS.json / the main feed.xml), so they need their own feed.
 *
 * Submit https://inkandchai.in/kawaii/feed.xml in Merchant Center as a scheduled
 * fetch. Runs in the Netlify build after generate_site.py.
 */

const fs = require('fs');
const path = require('path');

const SITE = 'https://inkandchai.in';
const BRAND = 'Kawaii Corner';

// Map internal category → Google product taxonomy
const GOOGLE_CATEGORY = {
  stickers:  'Arts & Entertainment > Hobbies & Creative Arts > Arts & Crafts > Art & Crafting Materials',
  washi:     'Arts & Entertainment > Hobbies & Creative Arts > Arts & Crafts > Art & Crafting Materials',
  art:       'Arts & Entertainment > Hobbies & Creative Arts > Arts & Crafts > Art & Crafting Materials',
  craft:     'Arts & Entertainment > Hobbies & Creative Arts > Arts & Crafts > Art & Crafting Materials',
  kits:      'Arts & Entertainment > Hobbies & Creative Arts > Arts & Crafts > Art & Crafting Materials',
  notebooks: 'Office Supplies > General Office Supplies > Notebooks & Notepads',
  pens:      'Office Supplies > General Office Supplies > Writing & Drawing Instruments',
  sticky:    'Office Supplies > General Office Supplies > Paper Products > Sticky Notes',
  packaging: 'Office Supplies > Shipping Supplies',
};

const CAT_LABEL = {
  stickers: 'Stickers', washi: 'Washi Tape', sticky: 'Sticky Notes',
  notebooks: 'Notebooks & Journals', pens: 'Pens & Markers', art: 'Art Supplies',
  craft: 'Craft Supplies', kits: 'Craft Kits', packaging: 'Gift Packaging',
};

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Load the kawaii catalogue by evaluating products.js
const productsSrc = fs.readFileSync(path.join(__dirname, 'public/kawaii/products.js'), 'utf8');
const PRODUCTS = new Function(productsSrc + '; return PRODUCTS;')();

const items = PRODUCTS.map((p) => {
  const link = `${SITE}/kawaii/product/?id=${encodeURIComponent(p.id)}`;
  const cat = GOOGLE_CATEGORY[p.cat] || 'Office Supplies > General Office Supplies';
  const catLabel = CAT_LABEL[p.cat] || 'Stationery';
  const desc = `${p.name} — ${catLabel} from Kawaii Corner by Ink & Chai. Premium aesthetic stationery, shipped pan-India.`;

  // price/sale_price: `price` is the selling price; `mrp` (if higher) is the list price.
  const hasSale = Number(p.mrp) > Number(p.price);
  const regular = hasSale ? Number(p.mrp) : Number(p.price);
  const priceLine = `<g:price>${regular}.00 INR</g:price>`;
  const saleLine = hasSale ? `\n      <g:sale_price>${Number(p.price)}.00 INR</g:sale_price>` : '';

  // up to 10 extra images (Google caps additional_image_link at 10)
  const extra = (Array.isArray(p.imgs) ? p.imgs : [])
    .filter((u) => u && u !== p.img)
    .slice(0, 10)
    .map((u) => `\n      <g:additional_image_link>${xmlEscape(u)}</g:additional_image_link>`)
    .join('');

  return `    <item>
      <g:id>kawaii-${xmlEscape(p.id)}</g:id>
      <g:title>${xmlEscape(p.name)}</g:title>
      <g:description>${xmlEscape(desc)}</g:description>
      <g:link>${xmlEscape(link)}</g:link>
      <g:image_link>${xmlEscape(p.img)}</g:image_link>${extra}
      <g:availability>in stock</g:availability>
      <g:condition>new</g:condition>
      ${priceLine}${saleLine}
      <g:brand>${xmlEscape(BRAND)}</g:brand>
      <g:google_product_category>${xmlEscape(cat)}</g:google_product_category>
      <g:product_type>${xmlEscape('Kawaii Corner > ' + catLabel)}</g:product_type>
      <g:identifier_exists>no</g:identifier_exists>
    </item>`;
}).join('\n');

const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Kawaii Corner by Ink &amp; Chai — Product Feed</title>
    <link>${SITE}/kawaii/</link>
    <description>Premium aesthetic stationery — stickers, washi, notebooks, pens and more.</description>
${items}
  </channel>
</rss>
`;

const out = path.join(__dirname, 'public/kawaii/feed.xml');
fs.writeFileSync(out, feed, 'utf8');
console.log(`Generated: public/kawaii/feed.xml (${PRODUCTS.length} products)`);
