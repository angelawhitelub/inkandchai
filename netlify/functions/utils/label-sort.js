/**
 * Turn a pile of XpressBees shipping labels into a packing run.
 *
 *   1. Pick list first, on label-sized pages: one row per book with the label
 *      range that needs it and how many copies, then the mixed orders.
 *   2. Labels sorted by quantity, high to low: orders of a single title are
 *      grouped (biggest title first, biggest order first within it), orders of
 *      several titles come after, most books first.
 *   3. The book name stamped big in the empty band under each label's own
 *      content, with "#N of M" and the item count, so a packer reads one line.
 *   4. One blank page last.
 *
 * Everything is read from the label itself -- the item table XpressBees
 * printed is what the packer will compare against, so it is the source of
 * truth, not our order rows. XpressBees labels are mPDF output: every text run
 * is `BT x y Td (UTF-16BE) Tj ET`, so the text and its position come straight
 * out of the content stream with no PDF text engine.
 *
 * Each page must contain an AWB it was requested for (each AWB on one page
 * only), or the build stops: the stamp is what gets packed, and a stamp on the
 * wrong label sends the wrong books. (XpressBees returns pages in request
 * order -- 265/265 checked on 6 Oct 2026 -- but that is an observation, not a
 * promise.) NimbusPost's labels are mPDF too and parse the same way.
 */
'use strict';

const { PDFDocument, PDFArray, PDFRawStream, StandardFonts, rgb, decodePDFRawStream } = require('pdf-lib');

// ── reading a label ─────────────────────────────────────────────────────────

function streamBytes(context, obj) {
  const s = obj && obj.constructor && obj.constructor.name === 'PDFRef' ? context.lookup(obj) : obj;
  if (!s) return new Uint8Array(0);
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  if (typeof s.getContents === 'function') return s.getContents();
  return new Uint8Array(0);
}

/** The page's content stream(s) as one latin1 string. */
function pageContent(page) {
  const context = page.doc.context;
  const c = page.node.Contents();
  const parts = c instanceof PDFArray ? c.asArray().map((r) => streamBytes(context, r)) : [streamBytes(context, c)];
  let out = '';
  for (const bytes of parts) {
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    out += '\n';
  }
  return out;
}

/** A PDF literal string's bytes (escapes resolved), as a latin1 string. */
function unescapeLiteral(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, e) => {
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8) & 0xff);
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[e];
  });
}

function decodeText(bytes) {
  // mPDF writes UTF-16BE; anything else is taken byte for byte.
  if (bytes.length % 2 === 0 && bytes.length && bytes.charCodeAt(0) === 0) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 2) out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
    return out;
  }
  return bytes;
}

/** Text runs with positions, and the lowest point anything is drawn at. */
function readPage(page) {
  const { width, height } = page.getSize();
  const c = pageContent(page);
  const texts = [];
  const lows = [];
  const segs = [];
  const textRe = /BT\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Td\s*\(((?:\\.|[^\\)])*)\)\s*Tj\s*ET/g;
  let m;
  while ((m = textRe.exec(c))) {
    const t = decodeText(unescapeLiteral(m[3])).trim();
    const x = Number(m[1]); const y = Number(m[2]);
    if (t) texts.push({ x, y, t });
    lows.push(y - 3);   // descenders
  }
  const imgRe = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+cm\s*\/\w+\s+Do/g;
  while ((m = imgRe.exec(c))) lows.push(Number(m[6]));
  const lineRe = /(-?[\d.]+)\s+(-?[\d.]+)\s+m\s+(-?[\d.]+)\s+(-?[\d.]+)\s+l/g;
  while ((m = lineRe.exec(c))) {
    const [x1, y1, x2, y2] = m.slice(1, 5).map(Number);
    // The label's own frame: rules drawn along the page edge (and a 1.5pt
    // tick at the origin). Both ends on the border = frame, not content.
    const onEdge = (x, y) => x < 3 || x > width - 3 || y < 3 || y > height - 3;
    if (onEdge(x1, y1) && onEdge(x2, y2)) continue;
    lows.push(y1, y2);
    segs.push({ x1, y1, x2, y2 });
  }
  const rectRe = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+re/g;
  while ((m = rectRe.exec(c))) {
    const [x, y, w, h] = m.slice(1, 5).map(Number);
    if (Math.abs(w) > width * 0.95 && Math.abs(h) > height * 0.9) continue;
    lows.push(Math.min(y, y + h));
  }
  return { texts, segs, contentBottom: lows.length ? Math.max(0, Math.min(...lows)) : height, width, height };
}

/**
 * The item table's cells, from its own grid: horizontal rules split rows,
 * vertical rules split SKU | Item Name | Qty. A wrapped title belongs to the
 * row whose rules enclose it -- placing lines by distance to the Qty figure
 * gave the last line of a 4-line title to the row below.
 */
function tableGrid(segs, header, floorY) {
  const near = (a, b) => Math.abs(a - b) < 0.6;
  const horiz = segs.filter((g) => near(g.y1, g.y2) && Math.abs(g.x2 - g.x1) > 4
    && g.y1 <= header.y + 12 && g.y1 >= floorY);
  const vert = segs.filter((g) => near(g.x1, g.x2) && Math.abs(g.y2 - g.y1) > 3
    && Math.max(g.y1, g.y2) <= header.y + 14 && Math.min(g.y1, g.y2) >= floorY - 1);
  const uniq = (vals) => vals.sort((a, b) => a - b).filter((v, i, a) => i === 0 || v - a[i - 1] > 1.5);
  const ys = uniq(horiz.map((g) => g.y1)).reverse();   // top to bottom
  const xs = uniq(vert.map((g) => g.x1));
  if (ys.length < 3 || xs.length < 4) return null;
  return { ys, xs };
}

function parseLabel(texts, segs = []) {
  const out = { orderNo: '', items: [] };
  const orderLine = texts.find((t) => /^Order No\s*:/i.test(t.t));
  if (orderLine) out.orderNo = orderLine.t.replace(/^Order No\s*:\s*/i, '').trim();
  const header = texts.find((t) => /^Qty\.?$/i.test(t.t));
  if (!header) return out;
  const footer = texts.filter((t) => t.y < header.y && /^For any query/i.test(t.t)).sort((a, b) => b.y - a.y)[0];
  const floorY = footer ? footer.y : 0;
  const grid = tableGrid(segs, header, floorY);
  if (!grid) { out.unreadReason = 'item table grid not found'; return out; }
  const { ys, xs } = grid;
  // Columns: the last three vertical rules bound Item Name and Qty.
  const qtyLeft = xs[xs.length - 2];
  const nameLeft = xs[xs.length - 3];
  for (let r = 0; r < ys.length - 1; r++) {
    const top = ys[r]; const bottom = ys[r + 1];
    const cell = texts.filter((t) => t.y < top && t.y > bottom);
    if (cell.some((t) => t === header)) continue;
    const qtyText = cell.filter((t) => t.x >= qtyLeft).map((t) => t.t).join('');
    const name = cell.filter((t) => t.x >= nameLeft && t.x < qtyLeft)
      .sort((a, b) => b.y - a.y || a.x - b.x).map((t) => t.t).join(' ').replace(/\s+/g, ' ').trim();
    // A row without a number in Qty is not an item (footer text, a blank row).
    if (!/^\d{1,3}$/.test(qtyText) || !name) continue;
    out.items.push({ title: name, qty: Number(qtyText) });
  }
  return out;
}

// ── sorting ─────────────────────────────────────────────────────────────────

/** Titles match regardless of case, punctuation and spacing. */
const titleKey = (t) => String(t || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function mergeItems(items) {
  const by = new Map();
  for (const i of items) {
    const k = titleKey(i.title);
    if (by.has(k)) by.get(k).qty += i.qty; else by.set(k, { title: i.title, qty: i.qty, key: k });
  }
  return [...by.values()];
}

/**
 * labels: [{ awb, ...parseLabel(), ... }] -> same objects, ordered, each with
 * kind 'single' | 'mixed' | 'unread'.
 */
function sortLabels(labels) {
  const single = new Map();
  const mixed = [];
  const unread = [];
  for (const l of labels) {
    l.items = mergeItems(l.items || []);
    l.units = l.items.reduce((s, i) => s + i.qty, 0);
    if (!l.items.length) { l.kind = 'unread'; unread.push(l); continue; }
    if (l.items.length === 1) {
      l.kind = 'single';
      const k = l.items[0].key;
      if (!single.has(k)) single.set(k, { title: l.items[0].title, units: 0, labels: [] });
      const g = single.get(k);
      g.units += l.units;
      g.labels.push(l);
      continue;
    }
    l.kind = 'mixed';
    mixed.push(l);
  }
  const groups = [...single.values()].sort((a, b) => b.units - a.units || b.labels.length - a.labels.length || a.title.localeCompare(b.title));
  for (const g of groups) g.labels.sort((a, b) => b.units - a.units);
  mixed.sort((a, b) => b.units - a.units || b.items.length - a.items.length);
  const ordered = [...groups.flatMap((g) => g.labels), ...mixed, ...unread];
  ordered.forEach((l, i) => { l.n = i + 1; });
  return { ordered, groups, mixed, unread };
}

// ── drawing ─────────────────────────────────────────────────────────────────

/** Helvetica speaks WinAnsi only; anything else would throw mid-build. */
function winAnsi(s) {
  return String(s || '').normalize('NFKC')
    .replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″]/g, '"').replace(/[‐‑‒–—―]/g, '-')
    .replace(/…/g, '...').replace(/•/g, '-')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '').replace(/\s+/g, ' ').trim();
}

function wrap(font, text, size, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= maxWidth || !cur) cur = next;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  // A single word wider than the box is cut rather than run off the page.
  return lines.map((l) => {
    let s = l;
    while (s.length > 1 && font.widthOfTextAtSize(s, size) > maxWidth) s = s.slice(0, -1);
    return s;
  });
}

/** Largest size (down to `min`) at which `text` fits in `maxLines` lines. */
function fit(font, text, maxWidth, maxHeight, { max = 22, min = 7, maxLines = 3, leading = 1.12 } = {}) {
  for (let size = max; size >= min; size -= 0.5) {
    const lines = wrap(font, text, size, maxWidth);
    if (lines.length <= maxLines && lines.length * size * leading <= maxHeight) return { size, lines };
  }
  return null;
}

const shortTitle = (t) => {
  const cut = String(t).split(/\s*[:(|]\s*|\s+-\s+/)[0].replace(/\s+by\s+.+$/i, '').trim();
  return cut.length >= 4 ? cut : String(t);
};

function stamp(page, label, total, fonts) {
  const { width } = page.getSize();
  const top = label.contentBottom - 6;
  const bottom = 6;
  const left = 10;
  const boxW = width - 2 * left;
  if (top - bottom < 18) return { stamped: false, reason: 'no room under the label' };
  const black = rgb(0, 0, 0);
  const info = `#${label.n} of ${total}  -  ${label.units} ${label.units === 1 ? 'ITEM' : 'ITEMS'}${label.kind === 'mixed' ? '  -  MIXED' : ''}`;
  page.drawText(info, { x: left, y: top - 10, size: 10, font: fonts.bold, color: black });
  page.drawLine({ start: { x: left, y: top - 14 }, end: { x: width - left, y: top - 14 }, thickness: 0.8, color: black });
  const areaTop = top - 18;
  const areaH = areaTop - bottom;

  const draw = (lines, size, font, x = left, w = boxW) => {
    let y = areaTop - size;
    for (const l of lines) { page.drawText(l, { x, y, size, font, color: black, maxWidth: w }); y -= size * 1.12; }
  };

  if (label.kind === 'single') {
    const it = label.items[0];
    const name = winAnsi(it.title) || 'SEE ITEM TABLE ABOVE';
    // Quantity always shown, 1 included: the packer checks the count too.
    const f = fit(fonts.bold, `${it.qty} x ${name}`, boxW, areaH, { max: 13, min: 7, maxLines: 3 });
    if (f) { draw(f.lines, f.size, fonts.bold); return { stamped: true }; }
  } else if (label.kind === 'mixed') {
    const lines = label.items.map((i) => `${i.qty} x ${winAnsi(shortTitle(i.title)) || '?'}`);
    // One column, then two, before giving up on listing them.
    for (let size = 10; size >= 7; size -= 0.5) {
      const fits1 = lines.every((l) => fonts.bold.widthOfTextAtSize(l, size) <= boxW) && lines.length * size * 1.12 <= areaH;
      if (fits1) { draw(lines, size, fonts.bold); return { stamped: true }; }
    }
    const colW = (boxW - 8) / 2;
    const half = Math.ceil(lines.length / 2);
    for (let size = 9; size >= 7; size -= 0.5) {
      const cut = (l) => { let s = l; while (s.length > 4 && fonts.bold.widthOfTextAtSize(s, size) > colW) s = s.slice(0, -1); return s; };
      if (half * size * 1.12 <= areaH) {
        draw(lines.slice(0, half).map(cut), size, fonts.bold, left, colW);
        draw(lines.slice(half).map(cut), size, fonts.bold, left + colW + 8, colW);
        return { stamped: true };
      }
    }
    const f = fit(fonts.bold, `${label.units} BOOKS - CHECK TABLE ABOVE`, boxW, areaH, { max: 16, min: 7, maxLines: 2 });
    if (f) { draw(f.lines, f.size, fonts.bold); return { stamped: true }; }
  } else {
    const f = fit(fonts.bold, 'ITEMS NOT READ - CHECK TABLE ABOVE', boxW, areaH, { max: 14, min: 7, maxLines: 2 });
    if (f) { draw(f.lines, f.size, fonts.bold); return { stamped: true }; }
  }
  return { stamped: false, reason: 'stamp did not fit' };
}

function rangeText(labels) {
  const ns = labels.map((l) => l.n).sort((a, b) => a - b);
  const parts = [];
  let start = ns[0]; let prev = ns[0];
  for (const n of ns.slice(1).concat([null])) {
    if (n === prev + 1) { prev = n; continue; }
    parts.push(start === prev ? `#${start}` : `#${start}-${prev}`);
    start = n; prev = n;
  }
  return parts.join(', ');
}

/** Pick-list pages, the same size as the labels so the printer roll is not swapped. */
function drawPickList(out, sorted, { width, height, fonts, title }) {
  const margin = 12;
  const black = rgb(0, 0, 0);
  const rows = [];
  for (const g of sorted.groups) rows.push({ range: rangeText(g.labels), qty: g.units, text: winAnsi(g.title) || '(title not readable)' });
  const mixedRows = sorted.mixed.map((l) => ({ range: `#${l.n}`, qty: l.units, text: l.items.map((i) => `${i.qty} x ${winAnsi(shortTitle(i.title))}`).join('; ') }));
  const unreadRows = sorted.unread.map((l) => ({ range: `#${l.n}`, qty: 0, text: `AWB ${l.awb} - items not read, check the label` }));

  let page = null; let y = 0;
  const newPage = (heading) => {
    page = out.addPage([width, height]);
    y = height - margin;
    page.drawText(title, { x: margin, y: y - 9, size: 9, font: fonts.bold, color: black });
    y -= 14;
    if (heading) { page.drawText(heading, { x: margin, y: y - 8, size: 8, font: fonts.bold, color: black }); y -= 12; }
  };
  const section = (heading, list) => {
    if (!list.length) return;
    if (!page || y < 60) newPage(heading);
    else { page.drawText(heading, { x: margin, y: y - 8, size: 8, font: fonts.bold, color: black }); y -= 12; }
    for (const r of list) {
      const textX = margin + 12 + 52 + 22;
      const lines = wrap(fonts.regular, r.text, 7.5, width - textX - margin);
      const rangeLines = wrap(fonts.regular, r.range, 7, 50);
      const h = Math.max(lines.length, rangeLines.length) * 8.6 + 3;
      if (y - h < margin) newPage(`${heading} (cont.)`);
      page.drawRectangle({ x: margin, y: y - 9, width: 7, height: 7, borderColor: black, borderWidth: 0.7 });
      rangeLines.forEach((l, i) => page.drawText(l, { x: margin + 12, y: y - 8 - i * 8.6, size: 7, font: fonts.regular, color: black }));
      if (r.qty) page.drawText(`${r.qty}x`, { x: margin + 12 + 52, y: y - 8, size: 8, font: fonts.bold, color: black });
      lines.forEach((l, i) => page.drawText(l, { x: textX, y: y - 8 - i * 8.6, size: 7.5, font: fonts.regular, color: black }));
      y -= h;
      page.drawLine({ start: { x: margin, y: y + 1 }, end: { x: width - margin, y: y + 1 }, thickness: 0.3, color: rgb(0.6, 0.6, 0.6) });
    }
    y -= 6;
  };
  section('SINGLE-TITLE ORDERS  (label range - copies - book)', rows);
  section('MIXED ORDERS  (one label each)', mixedRows);
  section('LABELS NOT READ', unreadRows);
  if (!page) newPage('No labels');
}

/**
 * sources: [{ bytes, awbs }] -- each a label PDF and the AWBs it was asked for
 * (pages in any order). Returns { pdf: Uint8Array, summary }.
 */
async function buildSortedLabels(sources, { date = new Date() } = {}) {
  const out = await PDFDocument.create();
  const fonts = { bold: await out.embedFont(StandardFonts.HelveticaBold), regular: await out.embedFont(StandardFonts.Helvetica) };
  const labels = [];
  let size = null;
  for (const src of sources) {
    const doc = await PDFDocument.load(src.bytes, { updateMetadata: false });
    const pages = doc.getPages();
    if (pages.length !== src.awbs.length) {
      throw new Error(`The courier returned ${pages.length} label pages for ${src.awbs.length} AWBs; nothing was built`);
    }
    // One copy call per source: XpressBees shares one resource dictionary
    // across every page, and copying page by page duplicates it each time.
    const copied = await out.copyPages(doc, pages.map((_, i) => i));
    // XpressBees keeps request order; NimbusPost need not. Each page must show
    // exactly one requested AWB not already taken by another page.
    const wanted = new Set(src.awbs.map(String));
    const taken = new Set();
    pages.forEach((p, i) => {
      const read = readPage(p);
      const shown = [...new Set(read.texts.map((t) => t.t).filter((t) => wanted.has(t) && !taken.has(t)))];
      const awb = shown.includes(String(src.awbs[i])) ? String(src.awbs[i]) : (shown.length === 1 ? shown[0] : null);
      if (!awb) {
        throw new Error(`Label page ${i + 1} of a batch does not show AWB ${src.awbs[i]}; nothing was built`);
      }
      taken.add(awb);
      if (!size) size = { width: read.width, height: read.height };
      labels.push({ awb, page: copied[i], contentBottom: read.contentBottom, ...parseLabel(read.texts, read.segs) });
    });
  }
  const sorted = sortLabels(labels);
  // The Worker runs on UTC; the packer's day is IST.
  const stampDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit' }).format(date);
  const units = labels.reduce((s, l) => s + (l.units || 0), 0);
  const width = size ? size.width : 286.3;
  const height = size ? size.height : 436.5;
  drawPickList(out, sorted, { width, height, fonts, title: `PICK LIST ${stampDate} - ${labels.length} labels - ${units} books` });
  const unstamped = [];
  for (const l of sorted.ordered) {
    out.addPage(l.page);
    const r = stamp(l.page, l, labels.length, fonts);
    if (!r.stamped) unstamped.push(`${l.awb}: ${r.reason}`);
  }
  out.addPage([width, height]);   // blank last page
  const pdf = await out.save();
  return {
    pdf,
    summary: {
      labels: labels.length, units, titles: sorted.groups.length, mixed: sorted.mixed.length,
      unread: sorted.unread.map((l) => l.awb), unstamped,
    },
  };
}

module.exports = { buildSortedLabels, readPage, parseLabel, sortLabels, winAnsi, titleKey, rangeText, shortTitle };
