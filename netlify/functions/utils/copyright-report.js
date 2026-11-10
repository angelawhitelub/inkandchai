'use strict';

/**
 * Copyright reports from the public /copyright/ form (10 Nov 2026).
 *
 * Pure parts (validation, reference numbers, the two emails) live here so they
 * can be tested without a database; the handler (copyright-report.js) does the
 * I/O. The owner's address is only ever read from env and used as a `to`; it
 * is never put in a page, a response or the reporter's email.
 */

const crypto = require('crypto');

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const LIMITS = { name: 120, email: 160, phone: 20, organisation: 160, product_url: 400, work: 4000, original_url: 400, details: 6000, signature: 120 };
const ROLES = { owner: 'Copyright owner', agent: 'Authorised agent of the owner' };

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (v, max) => String(v == null ? '' : v).replace(/\u0000/g, '').trim().slice(0, max);
const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e);

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newRef(now = new Date(), bytes = crypto.randomBytes(5)) {
  const d = now.toISOString().slice(0, 10).replace(/-/g, '');
  let s = '';
  for (let i = 0; i < 5; i += 1) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `CR-${d}-${s}`;
}

/** A product page link on our site → its slug ('' when it is not one). */
function productSlug(url) {
  const m = String(url || '').match(/^(?:https?:\/\/(?:www\.)?inkandchai\.in)?\/product\/([a-z0-9][a-z0-9-]*)\/?(?:[?#].*)?$/i);
  return m ? m[1].toLowerCase() : '';
}

function imageKind(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', type: 'image/png' };
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return null;
}

/**
 * Validates a submission. Returns { ok: true, report, images } or
 * { ok: false, field, error } with a message fit to show the person.
 */
function parseReport(body = {}) {
  const r = {};
  for (const [k, max] of Object.entries(LIMITS)) r[k] = clean(body[k], max);
  r.email = r.email.toLowerCase();
  r.role = ROLES[body.role] ? body.role : '';
  r.good_faith = body.good_faith === true;
  r.accurate = body.accurate === true;
  const bad = (field, error) => ({ ok: false, field, error });
  if (r.name.length < 2) return bad('name', 'Please enter your name.');
  if (!isEmail(r.email)) return bad('email', 'Please enter a valid email address so we can reply.');
  if (r.phone && !/^[+\d][\d\s-]{6,18}$/.test(r.phone)) return bad('phone', 'That phone number does not look right.');
  if (!r.role) return bad('role', 'Tell us whether you own the copyright or act for the owner.');
  if (!productSlug(r.product_url)) return bad('product_url', 'Paste the link of the Ink & Chai product page (it contains /product/).');
  if (r.work.length < 20) return bad('work', 'Describe the copyrighted work and who owns it (at least 20 characters).');
  if (r.original_url && !/^https?:\/\/\S+$/i.test(r.original_url)) return bad('original_url', 'The link to the original should start with http:// or https://');
  if (r.details.length < 20) return bad('details', 'Tell us what on the page infringes and why (at least 20 characters).');
  if (!r.good_faith) return bad('good_faith', 'Please confirm the good-faith statement.');
  if (!r.accurate) return bad('accurate', 'Please confirm the information is accurate.');
  if (r.signature.length < 2) return bad('signature', 'Type your full name as your signature.');
  r.product_slug = productSlug(r.product_url);

  const raw = Array.isArray(body.images) ? body.images : [];
  if (raw.length > MAX_IMAGES) return bad('images', `Attach at most ${MAX_IMAGES} images.`);
  const images = [];
  for (const [i, img] of raw.entries()) {
    const data = String((img && img.data) || '').replace(/^data:[^;,]+;base64,/, '');
    let buf;
    try { buf = Buffer.from(data, 'base64'); } catch { buf = Buffer.alloc(0); }
    if (!buf.length) return bad('images', `Image ${i + 1} could not be read. Try a JPG or PNG.`);
    if (buf.length > MAX_IMAGE_BYTES) return bad('images', `Image ${i + 1} is too large (max 3 MB).`);
    const kind = imageKind(buf);
    if (!kind) return bad('images', `Image ${i + 1} is not a JPG, PNG or WebP picture.`);
    images.push({ buf, ...kind, name: clean(img.name, 80).replace(/[^\w.\- ]+/g, '_') || `image-${i + 1}.${kind.ext}` });
  }
  return { ok: true, report: r, images };
}

function row(label, value) {
  return value ? `<tr><td style="padding:6px 10px;color:#6b5a48;vertical-align:top;white-space:nowrap;">${esc(label)}</td><td style="padding:6px 10px;white-space:pre-wrap;">${value}</td></tr>` : '';
}

/** The owner's copy: every field, the images attached. */
function ownerEmailHtml(ref, r, { saved, imageCount }) {
  const page = `https://inkandchai.in/product/${r.product_slug}/`;
  return `<div style="font-family:Arial,sans-serif;max-width:680px;color:#2b2118;">
  <h2 style="font-family:Georgia,serif;font-weight:400;margin:0 0 6px;">©️ Copyright report ${esc(ref)}</h2>
  <p style="margin:0 0 14px;color:#6b5a48;">About <a href="${esc(page)}">${esc(page)}</a>. Reply to the reporter at <a href="mailto:${esc(r.email)}">${esc(r.email)}</a>.</p>
  <table style="border-collapse:collapse;font-size:14px;border:1px solid #e6dccb;width:100%;">
    ${row('Reference', esc(ref))}
    ${row('Name', esc(r.name))}
    ${row('Email', `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>`)}
    ${row('Phone', esc(r.phone))}
    ${row('Organisation', esc(r.organisation))}
    ${row('Acting as', esc(ROLES[r.role]))}
    ${row('Product page', `<a href="${esc(page)}">${esc(r.product_url)}</a>`)}
    ${row('Copyrighted work', esc(r.work))}
    ${row('Original work link', r.original_url ? `<a href="${esc(r.original_url)}">${esc(r.original_url)}</a>` : '')}
    ${row('What infringes', esc(r.details))}
    ${row('Good-faith statement', r.good_faith ? 'Confirmed' : 'No')}
    ${row('Accuracy statement', r.accurate ? 'Confirmed' : 'No')}
    ${row('Signature', esc(r.signature))}
    ${row('Images', imageCount ? `${imageCount} attached to this email` : 'None')}
  </table>
  ${saved ? '' : '<p style="color:#b0412e;margin-top:12px;">Not saved in Supabase (table copyright_reports missing or unreachable). This email is the only copy — run sql/copyright_reports.sql.</p>'}
  <p style="font-size:12px;color:#8a7b6a;margin-top:14px;">To take the page down: admin → Products → open the book → Remove From Sale or Delete Product Page.</p>
</div>`;
}

/** The reporter's receipt. Names no person and no private address. */
function reporterEmailHtml(ref, r) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;color:#2b2118;background:#faf7f2;padding:24px;">
  <h2 style="font-family:Georgia,serif;font-weight:400;margin:0 0 10px;">We received your copyright report</h2>
  <p>Hi ${esc(r.name.split(' ')[0])},</p>
  <p>Thank you for telling us. Your reference is <strong>${esc(ref)}</strong>, about <a href="https://inkandchai.in/product/${esc(r.product_slug)}/">this page</a>.</p>
  <p>We respect the rights of authors, publishers and artists. We review every report, usually within 2 working days, and where it is valid we act on it, which can include removing the product page and stopping sale of the item. We may write to you at this address if we need more information.</p>
  <p style="font-size:12px;color:#8a7b6a;margin-top:20px;">Ink &amp; Chai · inkandchai.in</p>
</div>`;
}

module.exports = { parseReport, newRef, productSlug, imageKind, ownerEmailHtml, reporterEmailHtml, MAX_IMAGES, MAX_IMAGE_BYTES, ROLES };
