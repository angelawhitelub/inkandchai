/**
 * The Not Picked Up list as a PDF, oldest first: the attachment the daily
 * report (not-picked-up-report-scheduled) emails and WhatsApps.
 *
 * pdf-lib's standard Helvetica only encodes Latin-1 (WinAnsi), and embedding a
 * Devanagari font would still not shape it, so text is folded to what the font
 * can draw: ₹ -> Rs, curly quotes and dashes -> plain, anything else -> "?".
 * The order id, AWB and age -- what someone acts on -- are always ASCII.
 */
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { repeatedBooks } = require('./not-picked-up');

const PAGE_W = 842;   // A4 landscape
const PAGE_H = 595;
const MARGIN = 24;
const SIZE = 7.5;
const LINE = 9.5;

const COLS = [
  { key: 'n', title: '#', w: 22 },
  { key: 'order', title: 'Order', w: 112 },
  { key: 'age', title: 'Age', w: 36 },
  { key: 'books', title: 'Books', w: 214 },
  { key: 'awb', title: 'Courier / AWB', w: 128 },
  { key: 'scan', title: 'Last scan', w: 88 },
  { key: 'pay', title: 'Payment', w: 82 },
  { key: 'customer', title: 'Customer', w: 112 },
];

const FOLD = { '₹': 'Rs ', '×': 'x', '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '•': '-', '·': '-' };

function pdfSafe(text) {
  return String(text == null ? '' : text)
    .replace(/[₹×–—‘’“”…•·]/g, (c) => FOLD[c])
    .replace(/\s+/g, ' ')
    // WinAnsi: printable ASCII and Latin-1. A run of anything else is one "?".
    .replace(/[^\x20-\x7E\xA0-\xFF]+/g, '?')
    .trim();
}

function wrap(font, text, width, maxLines) {
  const words = pdfSafe(text).split(' ').filter(Boolean);
  const lines = [];
  let cur = '';
  const fits = (s) => font.widthOfTextAtSize(s, SIZE) <= width;
  for (let word of words) {
    while (!fits(word) && word.length > 1) {          // one very long token (an AWB, an email)
      let cut = word.length - 1;
      while (cut > 1 && !fits(word.slice(0, cut))) cut--;
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const next = cur ? cur + ' ' + word : word;
    if (fits(next)) cur = next;
    else { if (cur) lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last && !fits(last + '...')) last = last.slice(0, -1);
    kept[maxLines - 1] = last + '...';
    return kept;
  }
  return lines.length ? lines : [''];
}

const PAY = { cod: 'COD', prepaid: 'Prepaid', partial_cod: 'Partial COD', replacement: 'Free replacement' };
const ORIG = { cod: 'COD', prepaid: 'prepaid', partial_cod: 'partial COD', unknown: 'not found' };

function ageText(h) {
  const d = Math.floor(h / 24);
  return d ? `${d}d ${h % 24}h` : `${h}h`;
}

/** The Books cell: each book on its own line(s), "2 x" for more than one copy. */
function bookLines(font, r, width) {
  const items = Array.isArray(r.items) && r.items.length
    ? r.items.map((i) => `${Number(i.qty) > 1 ? `${i.qty} x ` : ''}${i.title}`)
    : [r.books || '-'];
  return items.flatMap((t) => wrap(font, t, width, items.length > 1 ? 3 : 6));
}

/** One table row's cells, as plain strings. */
function cellsFor(r, i) {
  const placed = new Date(r.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
  const rp = r.replacement;
  return {
    n: String(i + 1),
    order: `${r.order_id} ${placed}${rp ? ` | replaces ${rp.original_order_id || '?'}${rp.missing_book ? ' (missing book)' : rp.reason ? ` (${String(rp.reason).replace(/_/g, ' ')})` : ''}` : ''}`,
    age: ageText(r.age_hours),
    books: r.books || '-',
    awb: r.bucket === 'not_booked' ? 'Not booked yet' : `${r.courier || ''} ${r.tracking_id || ''}${r.courier_cancelled ? ' (courier voided)' : ''}`,
    scan: r.bucket === 'not_booked' ? r.status.replace(/_/g, ' ') : (r.last_scan || 'no scan'),
    pay: `${PAY[r.payment] || r.payment}${r.amount_rs ? ` Rs ${r.amount_rs}` : ''}${rp ? ` | original ${ORIG[rp.original_payment] || rp.original_payment || '?'}` : ''}`,
    customer: `${r.customer_name || ''} ${r.customer_phone || ''} ${r.pincode || ''}`,
  };
}

/**
 * rows: the Not Picked Up rows (utils/not-picked-up-list). Returns
 * { bytes: Uint8Array, count }. Sorted oldest first.
 */
async function buildNotPickedPdf(rows, { minDays, generatedAt = new Date() } = {}) {
  const sorted = [...rows].sort((a, b) => b.age_hours - a.age_hours);
  const doc = await PDFDocument.create();
  doc.setTitle(`Not picked up - ${minDays}+ days`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const grey = rgb(0.4, 0.4, 0.4);
  const red = rgb(0.75, 0.15, 0.15);

  const when = generatedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const notBooked = sorted.filter((r) => r.bucket === 'not_booked').length;
  const oldest = sorted.length ? Math.floor(sorted[0].age_hours / 24) : 0;
  const summary = `${sorted.length} orders placed ${minDays}+ days ago that no courier has picked up`
    + ` - ${sorted.length - notBooked} booked and waiting for pickup, ${notBooked} not booked. Oldest: ${oldest} days. Oldest first.`;

  let page;
  let y;
  const pages = [];
  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    y = PAGE_H - MARGIN;
    if (pages.length === 1) {
      page.drawText(`Ink & Chai - not picked up for ${minDays}+ days`, { x: MARGIN, y: y - 12, size: 14, font: bold });
      page.drawText(pdfSafe(`Generated ${when} IST`), { x: MARGIN, y: y - 26, size: 8, font, color: grey });
      page.drawText(pdfSafe(summary), { x: MARGIN, y: y - 38, size: 8.5, font });
      y -= 52;
    }
  };

  // Books in more than one copy, most first, three columns, before the orders.
  const repeated = repeatedBooks(sorted);
  newPage();
  if (repeated.length) {
    page.drawText(pdfSafe(`Books in more than one copy (${repeated.length})`), { x: MARGIN, y: y - 10, size: 10, font: bold });
    y -= 16;
    const PER_ROW = 3;
    const colW = (PAGE_W - 2 * MARGIN) / PER_ROW;
    for (let i = 0; i < repeated.length; i += PER_ROW) {
      if (y - LINE < MARGIN + 14) newPage();
      repeated.slice(i, i + PER_ROW).forEach((b, k) => {
        const x = MARGIN + k * colW;
        const qty = `${b.qty} x`;
        page.drawText(qty, { x: x + 2, y: y - 8, size: SIZE, font: bold });
        const rest = wrap(font, `${b.title} (${b.orders} order${b.orders === 1 ? '' : 's'})`, colW - 30, 1)[0];
        page.drawText(rest, { x: x + 24, y: y - 8, size: SIZE, font });
      });
      y -= LINE;
    }
    y -= 10;
  }

  let firstTable = true;
  const header = () => {
    if (!firstTable) newPage();
    firstTable = false;
    if (y < MARGIN + 60) newPage();
    let x = MARGIN;
    page.drawRectangle({ x: MARGIN, y: y - 12, width: PAGE_W - 2 * MARGIN, height: 13, color: rgb(0.92, 0.92, 0.92) });
    for (const c of COLS) {
      page.drawText(c.title, { x: x + 2, y: y - 9, size: SIZE, font: bold });
      x += c.w;
    }
    y -= 15;
  };
  header();

  if (!sorted.length) page.drawText('Nothing is waiting for pickup.', { x: MARGIN, y: y - 10, size: 9, font });

  sorted.forEach((r, i) => {
    const cells = cellsFor(r, i);
    const lines = Object.fromEntries(COLS.map((c) => [c.key, wrap(font, cells[c.key], c.w - 4, 3)]));
    // Every book of the order, one per line -- a multi-book order is packed
    // from this sheet, so none may be cut off.
    lines.books = bookLines(font, r, COLS.find((c) => c.key === 'books').w - 4);
    const height = Math.max(...Object.values(lines).map((l) => l.length)) * LINE + 4;
    if (y - height < MARGIN + 14) header();
    let x = MARGIN;
    for (const c of COLS) {
      lines[c.key].forEach((text, li) => {
        page.drawText(text, {
          x: x + 2, y: y - 8 - li * LINE, size: SIZE,
          font: c.key === 'order' && li === 0 ? bold : font,
          color: c.key === 'age' && r.age_hours >= 7 * 24 ? red : undefined,
        });
      });
      x += c.w;
    }
    y -= height;
    page.drawLine({ start: { x: MARGIN, y: y + 1 }, end: { x: PAGE_W - MARGIN, y: y + 1 }, thickness: 0.3, color: rgb(0.8, 0.8, 0.8) });
  });

  pages.forEach((p, i) => p.drawText(`Page ${i + 1} of ${pages.length}`, { x: PAGE_W - MARGIN - 60, y: MARGIN - 12, size: 7, font, color: grey }));
  return { bytes: await doc.save(), count: sorted.length, oldestDays: oldest, notBooked, repeated };
}

module.exports = { buildNotPickedPdf, pdfSafe, _test: { bookLines } };
