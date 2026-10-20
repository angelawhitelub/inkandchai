'use strict';

/**
 * Cash on Delivery switched off per book (sql/product_cod_rules.sql), set from
 * the admin product editor. Partial COD and prepaid stay open.
 *
 * Enforced in utils/pricing (the cart line gets _no_cod + _cod_note, and
 * cod-order refuses it), shown on the product page by the Worker and at
 * checkout from the public cod-off-slugs list. The older crossword import
 * still switches COD off with the `no-cod` product tag; both end in _no_cod.
 */

const TABLE = 'product_cod_rules';
const MAX_NOTE = 400;
const DEFAULT_NOTE = 'Cash on Delivery is not available for this title because we currently bring it from the publisher on demand. '
  + 'Kindly pay the partial amount (10% now, the rest on delivery) or the full amount online.';

const cleanSlug = (v) => {
  const s = String(v || '').trim().toLowerCase();
  return s && s.length <= 200 && !/[\s/?#,]/.test(s) ? s : '';
};

/** Plain text, one paragraph, capped; '' when blank. */
const cleanNote = (v) => String(v || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);

const noteOf = (row) => cleanNote(row && row.note) || DEFAULT_NOTE;

function isMissingTable(error) {
  const msg = String((error && error.message) || '');
  const code = String((error && error.code) || '');
  return code === '42P01' || (/product_cod_rules/.test(msg) && /(does not exist|schema cache|not find)/i.test(msg));
}

/** { slug: note } for the given slugs (case-insensitive). Missing table → {}. */
async function codRulesFor(db, slugs) {
  const list = [...new Set((slugs || []).map(cleanSlug).filter(Boolean))];
  if (!db || !list.length) return {};
  const { data, error } = await db.from(TABLE).select('slug,note').or(list.map((s) => `slug.ilike.${s}`).join(','));
  if (error) {
    if (!isMissingTable(error)) console.error('[cod-rules] lookup:', error.message);
    return {};
  }
  const out = {};
  for (const row of data || []) out[String(row.slug).toLowerCase()] = noteOf(row);
  return out;
}

/** Every rule, { slug: note }. Missing table → {}. */
async function allCodRules(db) {
  const out = {};
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await db.from(TABLE).select('slug,note').order('slug').range(from, from + 999);
    if (error) {
      if (isMissingTable(error)) return out;
      throw new Error(error.message);
    }
    for (const row of data || []) out[String(row.slug).toLowerCase()] = noteOf(row);
    if (!data || data.length < 1000) break;
  }
  return out;
}

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The product-page notice. data-cod-off marks it so a page never shows two. */
function codOffNoticeHtml(note) {
  return '<div data-cod-off="1" style="border:1px solid rgba(214,184,94,0.45);background:rgba(214,184,94,0.08);padding:0.85rem 1.05rem;'
    + 'border-radius:14px;margin:0.9rem 0;font-size:0.8rem;line-height:1.6;">'
    + '<strong style="display:block;margin-bottom:0.2rem;">🚫 Cash on Delivery unavailable for this title</strong>'
    + esc(note || DEFAULT_NOTE) + '</div>';
}

module.exports = { TABLE, MAX_NOTE, DEFAULT_NOTE, cleanSlug, cleanNote, isMissingTable, codRulesFor, allCodRules, codOffNoticeHtml };
