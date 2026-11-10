'use strict';

/**
 * Orders report PDF (admin "Unshipped report" / "Selected orders report").
 *
 * Page 1 on: every book across the orders, MOST COPIES FIRST, with the total
 * quantity and how many orders want it — a pick list. Then the orders
 * themselves, most copies first, each with its books.
 *
 * pdf-lib's Helvetica only draws Latin-1, so a title in Devanagari/Urdu is
 * shown by its product slug (which is romanised) when the item has one, and
 * folded to "?" otherwise. Order ids and quantities are always ASCII.
 */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const W = 595; const H = 842; const M = 32;     // A4 portrait
const SIZE = 8.5; const LINE = 11;
const MAX_ORDERS = 3000;
const MAX_ITEMS = 60;

const FOLD = { '₹': 'Rs ', '×': 'x', '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '•': '-', '·': '-' };
const safe = (t) => String(t == null ? '' : t)
  .replace(/[₹×–—‘’“”…•·]/g, (c) => FOLD[c])
  .replace(/\s+/g, ' ')
  .replace(/[^\x20-\x7E\xA0-\xFF]+/g, '?')
  .trim();
const latinOnly = (t) => !/[^\x20-\x7E\xA0-\xFF₹×–—‘’“”…•·\s]/.test(String(t || ''));
const humanSlug = (s) => String(s || '').replace(/-[a-z0-9]{0,3}\d[a-z0-9]*$/i, '').split('-').filter(Boolean)
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const normTitle = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** The text drawn for a title: itself, or its romanised slug when it is not Latin. */
function displayTitle(title, slug) {
  if (latinOnly(title)) return safe(title) || '(no title)';
  const h = humanSlug(slug);
  return h ? `${h} *` : (safe(title) || '(title not readable)');
}

/** Cleans what the admin page sent. */
function normalise(raw = []) {
  return (Array.isArray(raw) ? raw : []).slice(0, MAX_ORDERS).map((o) => ({
    id: String(o.id || '').slice(0, 60),
    date: String(o.date || '').slice(0, 40),
    customer: String(o.customer || '').slice(0, 80),
    pay: String(o.pay || '').slice(0, 30),
    items: (Array.isArray(o.items) ? o.items : []).slice(0, MAX_ITEMS).map((i) => ({
      title: String(i.title || '').slice(0, 300),
      slug: String(i.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 200),
      qty: Math.max(0, Math.min(999, parseInt(i.qty, 10) || 0)),
    })).filter((i) => i.qty > 0 && (i.title || i.slug)),
  })).filter((o) => o.id);
}

/** Books across all orders, most copies first (then most orders, then A–Z). */
function aggregate(orders) {
  const map = new Map();
  for (const o of orders) {
    const seen = new Set();
    for (const i of o.items) {
      const key = i.slug || `t:${normTitle(i.title)}`;
      let b = map.get(key);
      if (!b) { b = { key, title: i.title, slug: i.slug, qty: 0, orders: 0 }; map.set(key, b); }
      b.qty += i.qty;
      if (!seen.has(key)) { b.orders += 1; seen.add(key); }
    }
  }
  const books = [...map.values()].sort((a, b) => b.qty - a.qty || b.orders - a.orders
    || displayTitle(a.title, a.slug).localeCompare(displayTitle(b.title, b.slug)));
  const units = books.reduce((s, b) => s + b.qty, 0);
  const sortedOrders = orders.map((o) => ({ ...o, qty: o.items.reduce((s, i) => s + i.qty, 0) }))
    .sort((a, b) => b.qty - a.qty || String(a.date).localeCompare(String(b.date)));
  return { books, units, orders: sortedOrders };
}

function wrap(font, text, width, size = SIZE, maxLines = 3) {
  const words = safe(text).split(' ').filter(Boolean);
  const lines = []; let cur = '';
  const fits = (s) => font.widthOfTextAtSize(s, size) <= width;
  for (let w of words) {
    while (!fits(w) && w.length > 1) {
      let cut = w.length - 1;
      while (cut > 1 && !fits(w.slice(0, cut))) cut -= 1;
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(w.slice(0, cut)); w = w.slice(cut);
    }
    const next = cur ? `${cur} ${w}` : w;
    if (fits(next)) cur = next; else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last && !fits(`${last}...`)) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last}...`;
    return kept;
  }
  return lines.length ? lines : [''];
}

async function buildOrderReportPdf({ title = 'Orders report', orders: raw, generatedAt = new Date() } = {}) {
  const orders = normalise(raw);
  const agg = aggregate(orders);
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.1); const dim = rgb(0.4, 0.4, 0.4); const rule = rgb(0.82, 0.82, 0.82); const band = rgb(0.95, 0.95, 0.95);
  const when = generatedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

  let page; let y; let pageNo = 0;
  const footer = () => page.drawText(`${safe(title)} - ${when} IST - page ${pageNo}`, { x: M, y: 18, size: 7, font, color: dim });
  const newPage = () => {
    if (page) footer();
    page = doc.addPage([W, H]); pageNo += 1; y = H - M;
  };
  const text = (s, x, yy, f = font, size = SIZE, color = ink) => page.drawText(safe(s), { x, y: yy, size, font: f, color });

  // Columns → [{ key, title, x, w, align }]
  const header = (cols) => {
    page.drawRectangle({ x: M, y: y - 14, width: W - 2 * M, height: 15, color: band });
    for (const c of cols) {
      const tw = bold.widthOfTextAtSize(c.title, SIZE);
      text(c.title, c.align === 'right' ? c.x + c.w - tw : c.x, y - 10, bold);
    }
    y -= 18;
  };
  const table = (cols, rows, sectionTitle) => {
    const start = () => {
      text(sectionTitle, M, y - 12, bold, 11); y -= 20;
      header(cols);
    };
    if (y < 120) newPage();
    start();
    for (const r of rows) {
      const cells = cols.map((c) => {
        if (!c.wrap) return [safe(r[c.key])];
        // An array is one entry per line (e.g. one book per line), each wrapped.
        if (Array.isArray(r[c.key])) return r[c.key].flatMap((v) => wrap(font, v, c.w - 4, SIZE, 2)).slice(0, c.maxLines || 12);
        return wrap(font, r[c.key], c.w - 4, SIZE, c.maxLines || 3);
      });
      const h = Math.max(...cells.map((l) => l.length)) * LINE + 3;
      if (y - h < 34) { newPage(); text(`${sectionTitle} (continued)`, M, y - 12, bold, 11); y -= 20; header(cols); }
      cols.forEach((c, k) => cells[k].forEach((ln, j) => {
        const f = c.bold ? bold : font;
        const tw = f.widthOfTextAtSize(ln, SIZE);
        page.drawText(ln, { x: c.align === 'right' ? c.x + c.w - tw - 4 : c.x, y: y - 9 - j * LINE, size: SIZE, font: f, color: ink });
      }));
      if (r.boxed) page.drawRectangle({ x: M + 1, y: y - 10, width: 8, height: 8, borderColor: dim, borderWidth: 0.7 });
      y -= h;
      page.drawLine({ start: { x: M, y: y + 1 }, end: { x: W - M, y: y + 1 }, thickness: 0.4, color: rule });
    }
    y -= 14;
  };

  newPage();
  text(title, M, y - 16, bold, 16); y -= 26;
  text(`Ink & Chai - generated ${when} IST`, M, y - 9, font, 9, dim); y -= 18;
  text(`${agg.orders.length} orders - ${agg.units} books - ${agg.books.length} different titles`, M, y - 10, bold, 10.5); y -= 22;
  if (!agg.orders.length) text('No orders to report.', M, y - 10);

  const cw = W - 2 * M;
  if (agg.books.length) {
    table([
      { key: 'box', title: '', x: M, w: 14 },
      { key: 'n', title: '#', x: M + 14, w: 26, align: 'right' },
      { key: 'qty', title: 'Qty', x: M + 40, w: 36, align: 'right', bold: true },
      { key: 'title', title: 'Book', x: M + 84, w: cw - 84 - 60, wrap: true, maxLines: 3 },
      { key: 'orders', title: 'Orders', x: W - M - 56, w: 56, align: 'right' },
    ], agg.books.map((b, i) => ({ box: '', boxed: true, n: String(i + 1), qty: String(b.qty), title: displayTitle(b.title, b.slug), orders: String(b.orders) })),
    'Books to pick - most copies first');
  }
  if (agg.orders.length) {
    table([
      { key: 'n', title: '#', x: M, w: 24, align: 'right' },
      { key: 'id', title: 'Order', x: M + 30, w: 106, wrap: true, maxLines: 2 },
      { key: 'date', title: 'Date', x: M + 138, w: 74, wrap: true, maxLines: 2 },
      { key: 'customer', title: 'Customer', x: M + 214, w: 78, wrap: true, maxLines: 2 },
      { key: 'pay', title: 'Payment', x: M + 294, w: 52, wrap: true, maxLines: 2 },
      { key: 'qty', title: 'Qty', x: M + 346, w: 26, align: 'right', bold: true },
      { key: 'books', title: 'Books', x: M + 378, w: cw - 378, wrap: true, maxLines: 16 },
    ], agg.orders.map((o, i) => ({
      n: String(i + 1), id: o.id, date: o.date, customer: o.customer, pay: o.pay, qty: String(o.qty),
      books: o.items.map((it) => `${it.qty} x ${displayTitle(it.title, it.slug)}`),
    })), 'Orders - most copies first');
  }
  if (agg.books.some((b) => !latinOnly(b.title) && b.slug)) {
    if (y < 50) newPage();
    text('* Hindi/Urdu title shown by its web address name (the PDF font cannot draw that script).', M, y - 8, font, 7.5, dim);
  }
  footer();
  return { bytes: await doc.save(), summary: { orders: agg.orders.length, units: agg.units, titles: agg.books.length, top: agg.books.slice(0, 5).map((b) => ({ title: b.title, qty: b.qty })) } };
}

module.exports = { buildOrderReportPdf, aggregate, normalise, displayTitle, MAX_ORDERS };
