'use strict';

/**
 * The title an admin-added book is shown and advertised under: "Title by
 * Author", without the publisher's marketing subtitle.
 *
 * Why: Google Shopping and Performance Max have no keywords; they match a
 * search against the product title. "Trust Fall: From the no. 1 bestselling
 * author of Better than the Movies" never says "Lynn Painter", so a search for
 * "trust fall lynn painter" matched it weakly, and the marketing half reads as
 * promotional text to Merchant Center.
 *
 * One function for the product page (product-page.js) and both custom feeds,
 * because Merchant flags a feed title that differs from the landing page as
 * "Limited". The stored title is not changed; ✨ Draft with AI proposes the
 * same clean title for the admin to save.
 */

// A subtitle that sells rather than names the book. Matched per segment, so
// "A Talisman Novel" or "Book 3 (Shatter Me: The New Republic)" stay.
const PROMO = new RegExp([
  'best[- ]?sell(?:er|ing)', '\\bno\\.?\\s?1\\b', '#\\s?1\\b', '\\bnumber one\\b', 'sunday times', 'new york times', '\\bnyt\\b',
  'million copies', 'copies sold', '\\bauthor of\\b', '\\bfrom the (?:author|creator|writer)', '\\b(?:global|international|internet|viral|publishing|mystery|literary) sensation\\b',
  'must[- ]read', 'now a (?:major|netflix)', 'soon to be a', 'tik ?tok', 'book ?tok', 'award[- ]winning', '\\bwinner of\\b',
  'unputdownable', 'page[- ]turner', 'keep you up', 'perfect for fans', '\\binstant\\b', '\\bviral\\b', 'sold out',
  'the (?:haunting|gripping|addictive|twisty|heart-?(?:warming|breaking)|explosive|thrilling|stunning|unmissable|hotly anticipated)',
  '\\bnew (?:thriller|novel|romance|book) from\\b', 'tie-?in',
].join('|'), 'i');

const TIE_IN = /\b(?:film|movie|tv|netflix)?\s*tie-?in\b/i;
const GENERIC_AUTHOR = /^(?:various|various authors|unknown|anonymous|ink\s*&\s*chai|n\/?a|na|-|multiple authors)$/i;
const MULTI_BOOK = /\s\+\s|\bcombo\b|\bbox ?set\b|\bset of \d|\b\d+[- ]book\b|\bbundle\b|\bpack of\b/i;
const MAX = 150;   // Merchant Center's title limit

const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** "Lynn Painter" from "Lynn Painter, Someone Else" / "LYNN PAINTER & X". */
function firstAuthor(author) {
  const a = String(author || '').split(/\s*(?:,|;|&|\band\b)\s*/i)[0].replace(/\s+/g, ' ').trim();
  return a && !GENERIC_AUTHOR.test(a) && a.length <= 60 ? a : '';
}

/** Drop marketing subtitles; keep the part that names the book. */
function stripPromo(title) {
  const whole = String(title || '').replace(/\s+/g, ' ').trim();
  // A combo's "Set of 2 Bestsellers" is part of what it is: leave combos alone.
  if (MULTI_BOOK.test(whole)) return whole;
  // A trailing "by Author" outlives whatever subtitle it was stuck to.
  const by = whole.match(/^(.*\S)\s+(by\s+[^:|()[\]]{2,60})$/i);
  const t = by && /[:|([–—]/.test(by[1]) ? by[1] : whole;
  const tail = t === whole ? '' : ` ${by[2]}`;
  // Split at ":" " | " " – " " — " " - " and around "( … )" / "[ … ]".
  const parts = t.split(/(\s*:\s+|\s+[|–—-]\s+|\s*\([^)]*\)|\s*\[[^\]]*\])/);
  let head = parts[0];
  if (!head || PROMO.test(head)) return whole;   // never strip the title itself
  // A bracket is its own unit; the text after it is another.
  const units = [];
  for (let i = 1; i < parts.length; i += 2) {
    const sep = parts[i];
    const seg = parts[i + 1] || '';
    if (/^\s*[([]/.test(sep)) {
      units.push({ sep: '', text: sep });
      if (seg) units.push({ sep: '', text: seg });
    } else {
      units.push({ sep, text: seg });
    }
  }
  let tieIn = false;
  for (const { sep, text } of units) {
    if (PROMO.test(text)) {
      if (TIE_IN.test(text)) tieIn = true;
      continue;
    }
    head += `${sep}${text}`;
  }
  head = head.replace(/\s+/g, ' ').replace(/[\s:|–—-]+$/, '').trim();
  return `${tieIn ? `${head} (Film Tie-In Edition)` : head}${tail}`;
}

/**
 * The display title. Pure.
 *   displayTitle('Trust Fall: From the no. 1 bestselling author of Better than the Movies', 'Lynn Painter')
 *     → 'Trust Fall by Lynn Painter'
 */
function displayTitle(title, author) {
  const raw = String(title || '').replace(/\s+/g, ' ').trim();
  if (!raw) return raw;
  let t = stripPromo(raw);
  const who = firstAuthor(author);
  if (who && !MULTI_BOOK.test(t) && !/\sby\s/i.test(t)) {
    const surname = fold(who).split(' ').filter((w) => w.length > 2).pop() || fold(who);
    if (!fold(t).includes(fold(who)) && !fold(t).includes(surname)) {
      const withBy = `${t} by ${who}`;
      if (withBy.length <= MAX) t = withBy;
    }
  }
  return t.length > MAX ? t.slice(0, MAX).replace(/\s+\S*$/, '') : t;
}

module.exports = { displayTitle, stripPromo, firstAuthor };
