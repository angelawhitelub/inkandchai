'use strict';

/**
 * Website "Request a book" report PDF (admin Book Requests → From website
 * search → "📄 Download PDF").
 *
 * Page 1 on: every requested book, MOST REQUESTS FIRST, with how many times it
 * was asked for, by how many different customers, how many are still open and
 * when it was last asked. Then the same books in the same order, each with the
 * customers who asked (name, phone, email, times asked, status, note) so the
 * team can source the top titles and ring the people waiting for them.
 *
 * Helvetica only draws Latin-1: a Hindi/Urdu title falls back to what the
 * customer typed in search when that is Latin, else is marked unreadable.
 */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { safe, wrap, latinOnly } = require('./order-report-pdf');
const { groupByBook, asked } = require('./site-book-request');

const W = 595; const H = 842; const M = 32;     // A4 portrait
const SIZE = 8.5; const LINE = 11;

const STATUS_LABEL = {
  open: 'Open (new + sourcing)', new: 'New', sourcing: 'Sourcing', added: 'Added to site',
  unavailable: 'Unavailable', closed: 'Closed', '': 'All',
};

function bookTitle(b) {
  if (latinOnly(b.title)) return safe(b.title) || '(no title)';
  const q = (b.rows || []).map((r) => r.search_query).find((s) => s && latinOnly(s));
  return q ? `${safe(q)} *` : '(Hindi/Urdu title - see admin) *';
}
const withAuthor = (b) => (b.author && latinOnly(b.author) ? `${bookTitle(b)} - by ${safe(b.author)}` : bookTitle(b));
const day = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: '2-digit' });
};

async function buildBookRequestsPdf({ rows = [], status = 'open', generatedAt = new Date() } = {}) {
  const books = groupByBook(rows);
  const total = books.reduce((s, b) => s + b.requests, 0);
  const label = STATUS_LABEL[status] != null ? STATUS_LABEL[status] : String(status);
  const title = `Website book requests - ${label}`;

  const doc = await PDFDocument.create();
  doc.setTitle(title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.1); const dim = rgb(0.4, 0.4, 0.4); const rule = rgb(0.82, 0.82, 0.82);
  const band = rgb(0.95, 0.95, 0.95); const goldBand = rgb(0.98, 0.94, 0.82);
  const when = generatedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

  let page; let y; let pageNo = 0;
  const footer = () => page.drawText(`${safe(title)} - ${when} IST - page ${pageNo}`, { x: M, y: 18, size: 7, font, color: dim });
  const newPage = () => { if (page) footer(); page = doc.addPage([W, H]); pageNo += 1; y = H - M; };
  const text = (s, x, yy, f = font, size = SIZE, color = ink) => page.drawText(safe(s), { x, y: yy, size, font: f, color });

  const header = (cols) => {
    page.drawRectangle({ x: M, y: y - 14, width: W - 2 * M, height: 15, color: band });
    for (const c of cols) {
      const tw = bold.widthOfTextAtSize(c.title, SIZE);
      text(c.title, c.align === 'right' ? c.x + c.w - tw - 4 : c.x, y - 10, bold);
    }
    y -= 18;
  };
  /** One table row; onBreak redraws the headings on a new page. */
  const row = (cols, r, onBreak) => {
    const cells = cols.map((c) => (c.wrap ? wrap(font, r[c.key], c.w - 4, SIZE, c.maxLines || 3) : [safe(r[c.key])]));
    const h = Math.max(...cells.map((l) => l.length)) * LINE + 3;
    if (y - h < 34) { newPage(); onBreak(); }
    cols.forEach((c, k) => cells[k].forEach((ln, j) => {
      const f = c.bold ? bold : font;
      const tw = f.widthOfTextAtSize(ln, SIZE);
      page.drawText(ln, { x: c.align === 'right' ? c.x + c.w - tw - 4 : c.x, y: y - 9 - j * LINE, size: SIZE, font: f, color: ink });
    }));
    y -= h;
    page.drawLine({ start: { x: M, y: y + 1 }, end: { x: W - M, y: y + 1 }, thickness: 0.4, color: rule });
  };
  const section = (s) => { if (y < 120) newPage(); text(s, M, y - 12, bold, 11); y -= 20; };

  newPage();
  text(title, M, y - 16, bold, 16); y -= 26;
  text(`Ink & Chai - generated ${when} IST`, M, y - 9, font, 9, dim); y -= 18;
  text(`${total} requests from ${rows.length} customers - ${books.length} different books`, M, y - 10, bold, 10.5); y -= 22;
  if (!books.length) text('No requests to report.', M, y - 10);

  const cw = W - 2 * M;
  if (books.length) {
    const cols = [
      { key: 'n', title: '#', x: M, w: 26, align: 'right' },
      { key: 'requests', title: 'Requests', x: M + 28, w: 52, align: 'right', bold: true },
      { key: 'customers', title: 'Customers', x: M + 82, w: 56, align: 'right' },
      { key: 'open', title: 'Open', x: M + 140, w: 34, align: 'right' },
      { key: 'book', title: 'Book', x: M + 182, w: cw - 182 - 64, wrap: true, maxLines: 3 },
      { key: 'last', title: 'Last asked', x: W - M - 62, w: 62 },
    ];
    section('Books - most requested first');
    header(cols);
    books.forEach((b, i) => row(cols, {
      n: String(i + 1), requests: String(b.requests), customers: String(b.customers), open: String(b.open),
      book: withAuthor(b), last: day(b.last_at),
    }, () => { text('Books - most requested first (continued)', M, y - 12, bold, 11); y -= 20; header(cols); }));
    y -= 14;

    const pcols = [
      { key: 'customer', title: 'Customer', x: M + 4, w: 96, wrap: true, maxLines: 2 },
      { key: 'phone', title: 'Phone', x: M + 100, w: 70 },
      { key: 'email', title: 'Email', x: M + 170, w: 128, wrap: true, maxLines: 2 },
      { key: 'times', title: 'Asked', x: M + 298, w: 36, align: 'right', bold: true },
      { key: 'date', title: 'Date', x: M + 338, w: 52 },
      { key: 'status', title: 'Status', x: M + 390, w: 50 },
      { key: 'note', title: 'Note', x: M + 440, w: cw - 440, wrap: true, maxLines: 4 },
    ];
    section('Who asked - by book, most requested first');
    books.forEach((b, i) => {
      const headLines = wrap(bold, `${i + 1}. ${withAuthor(b)}  -  ${b.requests} request${b.requests === 1 ? '' : 's'}, ${b.customers} customer${b.customers === 1 ? '' : 's'}`, cw - 10, 9.5, 2);
      const need = headLines.length * 12 + 6 + 18 + LINE * 2;
      if (y - need < 34) newPage();
      const bh = headLines.length * 12 + 6;
      page.drawRectangle({ x: M, y: y - bh, width: cw, height: bh, color: goldBand });
      headLines.forEach((ln, j) => page.drawText(ln, { x: M + 5, y: y - 11 - j * 12, size: 9.5, font: bold, color: ink }));
      y -= bh + 2;
      header(pcols);
      const cont = () => {
        page.drawText(safe(`${i + 1}. ${bookTitle(b)} (continued)`), { x: M, y: y - 11, size: 9.5, font: bold, color: ink }); y -= 16;
        header(pcols);
      };
      for (const r of b.rows) {
        row(pcols, {
          customer: r.customer_name || '-', phone: r.phone ? `+91 ${r.phone}` : '', email: r.email || '',
          times: `${asked(r)}x`, date: day(r.created_at), status: r.status || 'new',
          note: [r.note, r.admin_note ? `(our note: ${r.admin_note})` : ''].filter(Boolean).join(' '),
        }, cont);
      }
      y -= 10;
    });
  }
  if (books.some((b) => !latinOnly(b.title))) {
    if (y < 50) newPage();
    text('* Hindi/Urdu title shown by what the customer searched (the PDF font cannot draw that script).', M, y - 8, font, 7.5, dim);
  }
  footer();
  return {
    bytes: await doc.save(),
    summary: { requests: total, customers: rows.length, books: books.length, top: books.slice(0, 5).map((b) => ({ title: b.title, requests: b.requests })) },
  };
}

module.exports = { buildBookRequestsPdf };
