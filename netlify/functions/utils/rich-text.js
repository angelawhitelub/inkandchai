/**
 * Markdown-lite → HTML for admin-written copy (book description, author bio).
 *
 * WHY NOT RAW HTML: the admin panel is the only writer, but "trusted author"
 * is not a security model — a pasted <script>, a stray onerror= in an <img>, or
 * copy taken from a supplier page would execute on every customer's product
 * page. So this ESCAPES EVERYTHING FIRST and only then re-introduces the
 * handful of tags it generates itself. There is no path from input text to a
 * tag or attribute this file did not write, which makes the output XSS-safe by
 * construction rather than by filtering.
 *
 * Supported, chosen to be typeable by hand without a toolbar:
 *   ## Heading        → <h3>
 *   **bold**          → <strong>
 *   *italic*  _it_    → <em>
 *   - bullet          → <ul><li>
 *   blank line        → new paragraph
 *   single newline    → <br>
 *
 * Anything else stays literal text, so an existing plain-text description
 * renders exactly as it did before.
 */

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Inline marks. Runs on ALREADY-ESCAPED text, so it can only ever wrap plain
// characters. ** is handled before * or "**x**" would parse as an empty italic.
function inlineMarks(escaped) {
  return escaped
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>')
    // _italic_ only between word boundaries, so snake_case_words survive intact.
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>');
}

/**
 * Render admin copy to safe HTML. Returns '' for empty input so callers can
 * use it directly in a `x ? block : ''` conditional.
 */
function richText(raw) {
  const text = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').trim();
  if (!text) return '';

  const out = [];
  let listItems = [];
  const flushList = () => {
    if (!listItems.length) return;
    out.push(`<ul>${listItems.map(li => `<li>${li}</li>`).join('')}</ul>`);
    listItems = [];
  };

  // Blank lines separate blocks; within a block a newline is a hard break.
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    // A block is a list only if every line is a bullet — otherwise a sentence
    // starting with a hyphen would silently become a list item.
    if (lines.every(l => /^\s*[-*•]\s+/.test(l))) {
      lines.forEach(l => listItems.push(inlineMarks(escapeHtml(l.replace(/^\s*[-*•]\s+/, '')))));
      flushList();
      continue;
    }
    flushList();

    const heading = block.match(/^\s*#{2,3}\s+(.+)$/);
    if (heading && lines.length === 1) {
      out.push(`<h3>${inlineMarks(escapeHtml(heading[1].trim()))}</h3>`);
      continue;
    }
    out.push(`<p>${lines.map(l => inlineMarks(escapeHtml(l))).join('<br/>')}</p>`);
  }
  flushList();
  return out.join('');
}

/**
 * Strip the formatting marks for places that need plain prose — meta
 * description, og:description, the schema.org feed Google ingests. Leaving
 * "**" in a Merchant Center description would show the asterisks verbatim.
 */
function plainText(raw) {
  return String(raw == null ? '' : raw)
    .replace(/^\s*#{2,3}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { richText, plainText, escapeHtml };
