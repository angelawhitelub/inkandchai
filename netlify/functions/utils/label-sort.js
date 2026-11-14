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

const { PDFDocument, PDFArray, PDFRawStream, StandardFonts, rgb, decodePDFRawStream,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, rectangle, clip, endPath } = require('pdf-lib');

// A label cut from an A4 sheet goes on a 4 x 6 inch page.
const LABEL_4X6 = { width: 288, height: 432 };

/**
 * Turn a copy of an A4 sheet into one 4 x 6 label: everything outside the
 * label's frame is clipped away, and the frame is scaled to fit the page,
 * centred. Drawing done later (the stamp) lands inside the same transform, so
 * it is placed in sheet coordinates like the label itself.
 */
function cropTo4x6(page, box) {
  const { width: PW, height: PH } = LABEL_4X6;
  const k = Math.min(PW / box.w, PH / box.h);
  const tx = (PW - k * box.w) / 2 - k * box.x;
  const ty = (PH - k * box.h) / 2 - k * box.y;
  page.node.normalize();
  page.getContentStream();   // pdf-lib's own stream for later drawing: inside the wrap
  const start = page.createContentStream(pushGraphicsState(), concatTransformationMatrix(k, 0, 0, k, tx, ty),
    rectangle(box.x, box.y, box.w, box.h), clip(), endPath());
  const end = page.createContentStream(popGraphicsState());
  page.node.wrapContentStreams(page.doc.context.register(start), page.doc.context.register(end));
  for (const set of ['setMediaBox', 'setCropBox', 'setTrimBox', 'setBleedBox', 'setArtBox']) page[set](0, 0, PW, PH);
}

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

/**
 * Text runs with positions, and the lowest point anything is drawn at.
 * With `box` ({x, y, w, h} in page space), only what lies inside the box is
 * read, in the box's own coordinates: one label cut out of an A4 sheet.
 */
function readPage(page, box = null) {
  const size = page.getSize();
  const width = box ? box.w : size.width;
  const height = box ? box.h : size.height;
  const ox = box ? box.x : 0;
  const oy = box ? box.y : 0;
  const inside = (x, y) => !box || (x >= -0.5 && x <= width + 0.5 && y >= -0.5 && y <= height + 0.5);
  const c = pageContent(page);
  const texts = [];
  const lows = [];
  const segs = [];
  const textRe = /BT\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Td\s*\(((?:\\.|[^\\)])*)\)\s*Tj\s*ET/g;
  let m;
  while ((m = textRe.exec(c))) {
    const t = decodeText(unescapeLiteral(m[3])).trim();
    const x = Number(m[1]) - ox; const y = Number(m[2]) - oy;
    if (!inside(x, y)) continue;
    if (t) texts.push({ x, y, t });
    lows.push(y - 3);   // descenders
  }
  const imgRe = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+cm\s*\/\w+\s+Do/g;
  const imgs = [];
  while ((m = imgRe.exec(c))) {
    const x = Number(m[5]) - ox; const y = Number(m[6]) - oy;
    if (!inside(x, y)) continue;
    lows.push(y);
    imgs.push({ x, y, w: Number(m[1]), h: Number(m[4]) });
  }
  const lineRe = /(-?[\d.]+)\s+(-?[\d.]+)\s+m\s+(-?[\d.]+)\s+(-?[\d.]+)\s+l/g;
  while ((m = lineRe.exec(c))) {
    const [x1, y1, x2, y2] = m.slice(1, 5).map(Number).map((v, i) => v - (i % 2 ? oy : ox));
    if (!inside(x1, y1) || !inside(x2, y2)) continue;
    // The label's own frame: rules drawn along the page edge (and a 1.5pt
    // tick at the origin). Both ends on the border = frame, not content.
    const onEdge = (x, y) => x < 3 || x > width - 3 || y < 3 || y > height - 3;
    if (onEdge(x1, y1) && onEdge(x2, y2)) continue;
    lows.push(y1, y2);
    segs.push({ x1, y1, x2, y2 });
  }
  const rectRe = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+re/g;
  while ((m = rectRe.exec(c))) {
    const [x0, y0, w, h] = m.slice(1, 5).map(Number);
    const x = x0 - ox; const y = y0 - oy;
    if (!inside(x, y)) continue;
    if (Math.abs(w) > width * 0.95 && Math.abs(h) > height * 0.9) continue;
    lows.push(Math.min(y, y + h));
  }
  return { texts, segs, imgs, contentBottom: lows.length ? Math.max(0, Math.min(...lows)) : height, width, height };
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
  // Columns by their headers: the rules either side of "Qty." and of "Item
  // Name". Thermal labels end at Qty.; A4 labels add an Amount column after it,
  // so "the last columns" is not a rule that holds for both.
  const colOf = (x) => { for (let i = 0; i < xs.length - 1; i++) if (x >= xs[i] - 0.5 && x < xs[i + 1]) return i; return -1; };
  const nameHead = texts.find((t) => /^Item\s*Name$/i.test(t.t) && Math.abs(t.y - header.y) < 3);
  let qi = colOf(header.x);
  if (qi < 1) qi = xs.length - 2;
  let ni = nameHead ? colOf(nameHead.x) : qi - 1;
  if (ni < 0 || ni >= qi) ni = qi - 1;
  const qtyLeft = xs[qi]; const qtyRight = xs[qi + 1];
  const nameLeft = xs[ni]; const nameRight = xs[ni + 1];
  for (let r = 0; r < ys.length - 1; r++) {
    const top = ys[r]; const bottom = ys[r + 1];
    const cell = texts.filter((t) => t.y < top && t.y > bottom);
    if (cell.some((t) => t === header)) continue;
    const qtyText = cell.filter((t) => t.x >= qtyLeft && t.x < qtyRight).map((t) => t.t).join('');
    const name = cell.filter((t) => t.x >= nameLeft && t.x < nameRight)
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

/** Draw calls shifted into a label's box, for a label cut out of a sheet. */
function inBox(page, box) {
  if (!box) return page;
  const sx = (o) => ({ ...o, x: o.x + box.x, y: o.y + box.y });
  return {
    getSize: () => ({ width: box.w, height: box.h }),
    drawText: (t, o) => page.drawText(t, sx(o)),
    drawLine: (o) => page.drawLine({ ...o, start: sx(o.start), end: sx(o.end) }),
    drawRectangle: (o) => page.drawRectangle(sx(o)),
  };
}

function stamp(pageIn, label, total, fonts) {
  const page = inBox(pageIn, label.box);
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
/**
 * XpressBees prints "A4" labels four to a sheet (2 x 2, each in its own ruled
 * frame) when the login's label setting is A4 -- the default for a login that
 * never chose. Find each requested AWB on the sheets and the frame around it.
 * Returns [{ pageIndex, awb, box }] in reading order, or throws when an AWB is
 * on no sheet or two share a frame. Box = the label's frame plus 1 pt, so the
 * frame sits on the cut edge and is not taken for content.
 */
function splitSheets(pages, awbs) {
  const wanted = new Set(awbs.map(String));
  const taken = new Set();
  const out = [];
  pages.forEach((page, pageIndex) => {
    const { width: W, height: H } = page.getSize();
    const cols = Math.max(1, Math.round(W / 297.6));
    const rows = Math.max(1, Math.round(H / 420.9));
    const cw = W / cols; const ch = H / rows;
    const full = readPage(page);
    const cells = new Map();
    for (const t of full.texts) {
      if (!wanted.has(t.t) || taken.has(t.t)) continue;
      const col = Math.min(cols - 1, Math.max(0, Math.floor(t.x / cw)));
      const row = Math.min(rows - 1, Math.max(0, Math.floor(t.y / ch)));
      const key = `${row}:${col}`;
      const prev = cells.get(key);
      if (prev && prev.awb !== t.t) throw new Error(`Label sheet ${pageIndex + 1} shows AWBs ${prev.awb} and ${t.t} in one label; nothing was built`);
      if (!prev) { cells.set(key, { row, col, awb: t.t }); taken.add(t.t); }
    }
    const found = [...cells.values()].sort((a, b) => b.row - a.row || a.col - b.col);   // top row first
    for (const cell of found) {
      const cx0 = cell.col * cw; const cy0 = cell.row * ch;
      const inCell = (x, y) => x >= cx0 - 1 && x <= cx0 + cw + 1 && y >= cy0 - 1 && y <= cy0 + ch + 1;
      const segs = full.segs.filter((sg) => inCell(sg.x1, sg.y1) && inCell(sg.x2, sg.y2));
      // The frame: the longest rules in the cell. Fall back to the whole cell.
      const xs = segs.flatMap((sg) => [sg.x1, sg.x2]); const ys = segs.flatMap((sg) => [sg.y1, sg.y2]);
      let box = { x: cx0, y: cy0, w: cw, h: ch };
      if (xs.length && Math.max(...xs) - Math.min(...xs) > cw * 0.6 && Math.max(...ys) - Math.min(...ys) > ch * 0.6) {
        const x = Math.max(cx0, Math.min(...xs) - 1); const y = Math.max(cy0, Math.min(...ys) - 1);
        box = { x, y, w: Math.min(cx0 + cw, Math.max(...xs) + 1) - x, h: Math.min(cy0 + ch, Math.max(...ys) + 1) - y };
      }
      out.push({ pageIndex, awb: cell.awb, box });
    }
  });
  const missing = awbs.map(String).filter((a) => !taken.has(a));
  if (missing.length) {
    throw new Error(`The courier returned ${pages.length} label sheets for ${awbs.length} AWBs and ${missing.length} are on none of them (first: ${missing[0]}); nothing was built`);
  }
  return out;
}

async function buildSortedLabels(sources, { date = new Date() } = {}) {
  const out = await PDFDocument.create();
  const fonts = { bold: await out.embedFont(StandardFonts.HelveticaBold), regular: await out.embedFont(StandardFonts.Helvetica) };
  const labels = [];
  let size = null;
  for (const src of sources) {
    const doc = await PDFDocument.load(src.bytes, { updateMetadata: false });
    const pages = doc.getPages();
    if (pages.length < src.awbs.length && pages.length && pages[0].getSize().width > 500) {
      // A4 sheets, several labels each: copy the sheet once per label and
      // crop each copy to that label's frame.
      const cuts = splitSheets(pages, src.awbs);
      const copies = await out.copyPages(doc, cuts.map((c) => c.pageIndex));
      cuts.forEach((cut, i) => {
        const pg = copies[i];
        cropTo4x6(pg, cut.box);
        const read = readPage(pages[cut.pageIndex], cut.box);
        if (!size) size = { ...LABEL_4X6 };
        labels.push({ awb: cut.awb, page: pg, box: cut.box, contentBottom: read.contentBottom, ...parseLabel(read.texts, read.segs) });
      });
      continue;
    }
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

module.exports = { buildSortedLabels, splitSheets, readPage, parseLabel, sortLabels, winAnsi, titleKey, rangeText, shortTitle };
