/**
 * "Other details" for a product listing — page count, trim size, weight,
 * edition, publication date, reading age.
 *
 * Value logic only, no HTML: the caller owns escaping, so this module can be
 * tested without a DOM and cannot be the place an unescaped title slips out.
 *
 * Every field is optional and every one is OMITTED rather than filled with a
 * placeholder. A Details table that prints "Dimensions: —" tells a buyer
 * nothing, and a page count we invented would be a factual claim about a
 * physical object the customer is about to pay for.
 */

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

/** Whole positive count, or '' when unknown. Never 0 — see module note. */
function count(value) {
  const n = Number(text(value));
  return Number.isFinite(n) && n > 0 ? String(Math.round(n)) : '';
}

/**
 * Grams below a kilo, kilos above it: "1250 g" reads as a number, "1.25 kg"
 * reads as a weight. Trailing zeros are dropped, so 2000 g is "2 kg".
 */
function weightText(grams) {
  const g = Number(text(grams));
  if (!Number.isFinite(g) || g <= 0) return '';
  return g < 1000 ? `${Math.round(g)} g` : `${Number((g / 1000).toFixed(2))} kg`;
}

/**
 * schema.org datePublished has to be a date, not prose. Admins type whatever
 * the copyright page says — "March 2024", "Reprint 2019" — so only emit it
 * when the value is already ISO-shaped. The Details table still shows exactly
 * what was typed either way.
 */
function schemaDatePublished(value) {
  const raw = text(value);
  return /^\d{4}(-\d{2}(-\d{2})?)?$/.test(raw) ? raw : undefined;
}

/**
 * The optional rows, in reading order, with the blanks already dropped.
 * `after` is the existing Details row each one follows, so the caller can
 * splice them into the fixed table without this module knowing any markup.
 */
function bookDetailRows(product) {
  const p = product || {};
  return [
    { after: 'format', label: 'Pages', value: count(p.pages) },
    { after: 'language', label: 'Edition', value: text(p.edition) },
    { after: 'language', label: 'Published', value: text(p.published_on) },
    { after: 'isbn', label: 'Dimensions', value: text(p.dimensions) },
    { after: 'isbn', label: 'Weight', value: weightText(p.weight_grams) },
    { after: 'isbn', label: 'Reading age', value: text(p.reading_age) },
  ].filter(row => row.value);
}

/** The subset of these that schema.org's Book type actually defines. */
function schemaBookDetails(product) {
  const p = product || {};
  const pages = count(p.pages);
  return {
    numberOfPages: pages ? Number(pages) : undefined,
    bookEdition: text(p.edition) || undefined,
    datePublished: schemaDatePublished(p.published_on),
    typicalAgeRange: text(p.reading_age) || undefined,
  };
}

module.exports = { bookDetailRows, schemaBookDetails, weightText, schemaDatePublished, count };
