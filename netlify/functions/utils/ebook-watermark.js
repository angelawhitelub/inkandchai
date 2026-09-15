/**
 * Stamping a buyer's identity into the PDF itself.
 *
 * WHY BAKED IN, NOT DRAWN IN THE READER
 * A watermark painted over the page by JavaScript is decoration: it lives in
 * the browser, and anyone who opens the network tab has the clean bytes. This
 * writes into the PDF's own content streams before it ever leaves the server,
 * so every copy that can possibly exist carries the name of the account it was
 * served to. It does not stop a determined person extracting the file — nothing
 * can, because the bytes must reach the reader to be read — but it does mean a
 * leaked copy identifies the buyer, which is the deterrent that actually works.
 *
 * WHY IT IS CACHED
 * Stamping a few hundred pages is slow and the result never changes for a given
 * buyer, so the personalised copy is written back to R2 and reused. The first
 * read pays the cost; every later one streams a stored object.
 *
 * SIZE CAP
 * pdf-lib parses the whole document in memory, and a worker has 128 MB. A large
 * scanned book would exceed that and take the request down, so past the cap the
 * original is served unstamped rather than failing — an unwatermarked read
 * beats a customer who cannot open the book they paid for. The cap is reported
 * so the caller can log it.
 */

const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');

/** Beyond this, stamping is skipped rather than risking the worker's memory. */
const MAX_STAMP_BYTES = 24 * 1024 * 1024;

/** Where a buyer's personalised copy lives. */
function personalKey(slug, userId) {
  return `ebooks/${slug}/personal/${String(userId).replace(/[^a-zA-Z0-9-]/g, '')}.pdf`;
}

/**
 * Draw the buyer's identity across every page.
 *
 * Two marks per page, on purpose. The diagonal one is large and hard to crop
 * out; the footer one stays legible when the page is scaled down to a phone
 * screen, where the diagonal becomes a blur.
 */
async function stampPdf(bytes, { label }) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();

  for (const page of pages) {
    const { width, height } = page.getSize();

    // Diagonal, faint enough to read through and dark enough to survive a
    // screenshot that has been through a messaging app twice.
    const diagSize = Math.max(14, Math.min(28, width / 26));
    page.drawText(label, {
      x: width * 0.08,
      y: height * 0.32,
      size: diagSize,
      font,
      color: rgb(0.55, 0.45, 0.2),
      opacity: 0.18,
      rotate: degrees(38),
    });

    // Footer line: small, solid, and always in the same place.
    const footSize = Math.max(6, Math.min(9, width / 70));
    page.drawText(label, {
      x: 24,
      y: 16,
      size: footSize,
      font,
      color: rgb(0.45, 0.4, 0.3),
      opacity: 0.55,
    });
  }

  // Metadata too: it survives copy-paste of the file and costs nothing.
  try {
    pdf.setProducer('Ink & Chai — ' + label);
    pdf.setCreator('Ink & Chai');
  } catch (e) { /* some documents refuse metadata edits */ }

  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

/**
 * The line printed on every page. Email plus a short order reference: enough to
 * identify the account without printing anything the buyer would not expect to
 * see on their own copy.
 */
function watermarkLabel({ email, userId, paymentId }) {
  const who = email || ('account ' + String(userId || '').slice(0, 8));
  const ref = paymentId ? ' · ' + String(paymentId).slice(-8) : '';
  return `Licensed to ${who}${ref} · inkandchai.in`;
}

/** How much of a book anyone may read before paying. Kindle's own default. */
const SAMPLE_PAGES = 5;

/**
 * Where the built sample lives. Identical for every visitor, so it is built
 * once and cached.
 *
 * Keyed by the source file, not just the slug: replacing a book's PDF mints a
 * new r2_key, which mints a new sample key, so a corrected edition cannot go on
 * being advertised by the old book's opening pages.
 */
function sampleKey(slug, r2Key) {
  const stamp = crypto.createHash('sha256').update(String(r2Key || '')).digest('hex').slice(0, 10);
  return `ebooks/${slug}/sample-${stamp}.pdf`;
}

/**
 * The first few pages, as their own document.
 *
 * Built by copying pages into a NEW document rather than deleting pages from
 * the original. Deleting leaves the removed pages' objects in the file — the
 * text is still in there for anyone who looks — which would hand out the whole
 * book under the name "sample".
 */
async function buildSample(bytes, { label, pages = SAMPLE_PAGES } = {}) {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const total = src.getPageCount();
  const take = Math.max(1, Math.min(pages, total));

  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, Array.from({ length: take }, (_, i) => i));
  for (const p of copied) out.addPage(p);

  const font = await out.embedFont(StandardFonts.Helvetica);
  const mark = label || `Free sample · first ${take} of ${total} pages · inkandchai.in`;
  for (const page of out.getPages()) {
    const { width } = page.getSize();
    page.drawText(mark, {
      x: 24, y: 16,
      size: Math.max(6, Math.min(9, width / 70)),
      font, color: rgb(0.45, 0.4, 0.3), opacity: 0.7,
    });
  }
  try { out.setProducer('Ink & Chai — free sample'); } catch (e) { /* ignore */ }

  return { bytes: Buffer.from(await out.save({ useObjectStreams: false })), pages: take, total };
}

module.exports = {
  stampPdf, watermarkLabel, personalKey, MAX_STAMP_BYTES,
  buildSample, sampleKey, SAMPLE_PAGES,
};
