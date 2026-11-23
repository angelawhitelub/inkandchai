'use strict';

/**
 * Pay Later (owner, 23 Nov 2026): selected books can be ordered now and paid
 * within 7 days of delivery, by trusted customers only.
 *
 *   - The owner picks the books (admin product editor) and switches the whole
 *     feature on or off (admin 💳 Pay Later tab). Off until the owner says so.
 *     One KV blob, `catalog:pay-later`: { enabled, items: [{ slug, title }] }.
 *   - Only a cart made entirely of selected books qualifies.
 *   - Only customers with at least MIN_DELIVERED delivered orders (matched by
 *     the last 10 digits of the phone), or whom the owner added by phone in
 *     the admin tab (`allow`), are eligible; everyone else is told they are
 *     not eligible yet. There is no application form.
 *   - The customer uploads a PAN card photo and gives the name on PAN, the PAN
 *     number, a bank account number and IFSC, with consent, for the owner's
 *     manual credit-score check. Those details live ONLY in the private R2
 *     bucket (never in the orders table, so staff logins never see them).
 *   - The order is saved as status `pay_later_review` (nothing ships), and the
 *     owner approves (→ `confirmed`, ships as a prepaid parcel that collects
 *     nothing) or rejects (→ `cancelled`).
 *   - On delivery a Razorpay payment link is sent; due DUE_DAYS later. A paid
 *     link writes razorpay_payment_id, so from then on the order is an
 *     ordinary prepaid order everywhere (refunds, reports).
 *
 * Marker: cart_items[0]._payment = { mode: 'pay_later', state, ... }.
 */
let blobs = null;
try { blobs = require('@netlify/blobs'); } catch { blobs = null; }
const getStore = (name) => {
  if (!blobs || typeof blobs.getStore !== 'function') throw new Error('Blob store is not available');
  return blobs.getStore(name);
};
const { normSlug } = require('./product-id');

const STORE = 'catalog';
const KEY = 'pay-later';
const MIN_DELIVERED = 5;
const DUE_DAYS = 7;
const REVIEW_STATUS = 'pay_later_review';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const NOT_ELIGIBLE = `You are currently not eligible for Pay Later. Pay Later is available to customers with at least ${MIN_DELIVERED} successful (delivered) orders with us.`;

/** The customer-facing explanation, shown above the form and in the emails. */
const WHY_TEXT = [
  'Pay Later means we send your books first and you pay within 7 days of delivery. Because this is credit, we check your credit score before we confirm the order.',
  'Your PAN card is how a credit bureau identifies you, so we need a clear photo of it (front side, all four corners visible) and your PAN number.',
  'Your bank account number and IFSC let us confirm that the account belongs to the same person as the PAN.',
  'The name on your PAN card must match the name on your bank account exactly. If the names differ, the credit score check fails and we cannot approve Pay Later.',
  'We use these details only to check your credit score and confirm your identity for this order. We never debit your account.',
  'No OTP is needed for Pay Later. Our employees will never call or message you asking for an OTP, PIN, password or card details. If anyone does, it is not us: do not share it.',
  'Nothing is charged now. We confirm or decline your order, usually within 24 hours. Once it is delivered we send you a secure Razorpay payment link, to be paid within 7 days.',
];
const CONSENT_TEXT = 'I agree that Ink & Chai may use my PAN and bank account details to check my credit score and confirm my identity for this Pay Later order.';

// ── Settings (KV) ───────────────────────────────────────────────────────────
async function readConfig() {
  const doc = await getStore(STORE).get(KEY, { type: 'json' });
  const items = doc && Array.isArray(doc.items) ? doc.items : [];
  return {
    enabled: !!(doc && doc.enabled === true),
    items: items.map((i) => ({ ...i, slug: normSlug(i && i.slug) })).filter((i) => i.slug),
    // Customers the owner let in without MIN_DELIVERED delivered orders.
    allow: (doc && Array.isArray(doc.allow) ? doc.allow : []).filter((a) => a && /^\d{10}$/.test(a.phone)),
    updated_at: (doc && doc.updated_at) || null,
  };
}

let cache = null;
let at = 0;
/** Cached a minute per isolate; a failed read keeps the last good copy (or "off"). */
async function config() {
  if (cache && Date.now() - at < 60000) return cache;
  try { cache = await readConfig(); }
  catch (e) { console.warn('[pay-later] read failed:', e.message); cache = cache || { enabled: false, items: [], allow: [] }; }
  at = Date.now();
  return cache;
}

async function writeConfig(next) {
  const now = new Date().toISOString();
  const doc = { enabled: !!next.enabled, items: next.items, allow: next.allow || [], updated_at: now };
  await getStore(STORE).setJSON(KEY, doc);
  cache = doc; at = Date.now();
  return doc;
}

async function setEnabled(on) {
  const cur = await readConfig();
  return writeConfig({ ...cur, enabled: on === true });
}

async function setBook(slug, on, { title = '' } = {}) {
  const s = normSlug(slug);
  if (!s) throw new Error('Missing product slug');
  const cur = await readConfig();
  const prev = cur.items.find((i) => i.slug === s);
  const items = cur.items.filter((i) => i.slug !== s);
  if (on) items.unshift({ slug: s, title: String(title || (prev && prev.title) || '').slice(0, 200), since: (prev && prev.since) || new Date().toISOString() });
  if (items.length > 5000) throw new Error('At most 5000 books can be marked.');
  return writeConfig({ ...cur, items });
}

/**
 * Lets one customer (by the last 10 digits of the phone) use Pay Later
 * without MIN_DELIVERED delivered orders, or takes that back. Owner only.
 */
async function setAllowed(phone, on, { name = '', note = '' } = {}) {
  const ten = phone10(phone);
  if (ten.length !== 10) throw new Error('Enter a 10-digit mobile number.');
  const cur = await readConfig();
  const prev = cur.allow.find((a) => a.phone === ten);
  const allow = cur.allow.filter((a) => a.phone !== ten);
  if (on) {
    allow.unshift({
      phone: ten,
      name: String(name || (prev && prev.name) || '').slice(0, 100),
      note: String(note || (prev && prev.note) || '').slice(0, 200),
      added_at: (prev && prev.added_at) || new Date().toISOString(),
    });
  }
  if (allow.length > 5000) throw new Error('At most 5000 customers can be added.');
  return writeConfig({ ...cur, allow });
}

const isAllowed = (cfg, phone) => {
  const ten = phone10(phone);
  return ten.length === 10 && (cfg && cfg.allow || []).some((a) => a.phone === ten);
};

/**
 * Who may use Pay Later: MIN_DELIVERED delivered orders, or on the owner's
 * allow-list. The list is checked first, so it needs no database read.
 * @returns {{ eligible, allowed, delivered }}
 */
async function eligibility(supabase, cfg, phone) {
  if (isAllowed(cfg, phone)) return { eligible: true, allowed: true, delivered: null };
  const delivered = await deliveredCount(supabase, phone);
  return { eligible: delivered >= MIN_DELIVERED, allowed: false, delivered };
}

// ── Cart and order helpers ──────────────────────────────────────────────────
const slugSet = (cfg) => new Set((cfg && cfg.items || []).map((i) => i.slug));

/** 'all' = every line is a Pay Later book; 'some' = at least one; 'none'. */
function cartCoverage(cart, cfg) {
  const set = slugSet(cfg);
  const lines = (Array.isArray(cart) ? cart : []).filter(Boolean);
  if (!lines.length) return 'none';
  const hits = lines.filter((i) => set.has(normSlug(i.slug)));
  if (hits.length === lines.length) return 'all';
  return hits.length ? 'some' : 'none';
}

function cartItems(order) {
  let items = order && order.cart_items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
  return Array.isArray(items) ? items : [];
}

const { payLaterMeta, isPayLater, isUnpaidPayLater } = require('./pay-later-kind');

/** cart_items with _payment replaced by fn(old) — returns a new array. */
function withMeta(order, fn) {
  const items = cartItems(order).map((i) => ({ ...i }));
  if (!items.length) return items;
  items[0]._payment = fn({ ...(items[0]._payment || {}) });
  return items;
}

const phone10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

/** Delivered orders on this phone (free replacements excluded). */
async function deliveredCount(supabase, phone) {
  const ten = phone10(phone);
  if (ten.length !== 10) return 0;
  const { count, error } = await supabase.from('orders')
    .select('id', { count: 'exact', head: true })
    .like('customer_phone', `%${ten}`)
    .eq('status', 'delivered')
    .not('razorpay_order_id', 'like', 'IC-R-%');
  if (error) throw new Error(error.message);
  return Number(count) || 0;
}

// ── KYC input checks ────────────────────────────────────────────────────────
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

function cleanKyc(raw = {}) {
  return {
    pan: String(raw.pan || '').toUpperCase().replace(/\s+/g, ''),
    pan_name: String(raw.pan_name || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    account: String(raw.account || '').replace(/\s+/g, ''),
    account_confirm: String(raw.account_confirm || '').replace(/\s+/g, ''),
    ifsc: String(raw.ifsc || '').toUpperCase().replace(/\s+/g, ''),
    consent: raw.consent === true,
  };
}

/** @returns {string|null} the first problem, in words a customer understands. */
function kycProblem(k) {
  if (!k.pan_name || k.pan_name.length < 3) return 'Enter your name exactly as it is printed on your PAN card.';
  if (!PAN_RE.test(k.pan)) return 'Enter a valid 10-character PAN number (like ABCDE1234F).';
  if (!/^\d{9,18}$/.test(k.account)) return 'Enter a valid bank account number (9 to 18 digits).';
  if (k.account !== k.account_confirm) return 'The two bank account numbers do not match.';
  if (!IFSC_RE.test(k.ifsc)) return 'Enter a valid 11-character IFSC code (like SBIN0001234).';
  if (!k.consent) return 'Please tick the consent box so we can check your credit score.';
  return null;
}

/** Decodes and checks the PAN photo. @returns {{ ok, buffer?, type?, ext?, error? }} */
function decodeImage(img) {
  const type = String(img && img.type || '').toLowerCase();
  const ext = IMAGE_TYPES[type];
  if (!ext) return { ok: false, error: 'Upload your PAN card as a photo (JPG, PNG or WebP).' };
  const b64 = String(img && img.data || '').replace(/^data:[^,]*,/, '');
  let buffer;
  try { buffer = Buffer.from(b64, 'base64'); } catch { buffer = null; }
  if (!buffer || buffer.length < 2000) return { ok: false, error: 'The PAN card photo did not come through. Please choose it again.' };
  if (buffer.length > MAX_IMAGE_BYTES) return { ok: false, error: 'The PAN card photo is too large. Please use a photo under 4 MB.' };
  const sig = buffer.subarray(0, 12);
  const looks = (ext === 'jpg' && sig[0] === 0xff && sig[1] === 0xd8)
    || (ext === 'png' && sig[0] === 0x89 && sig[1] === 0x50)
    || (ext === 'webp' && sig.subarray(8, 12).toString() === 'WEBP');
  if (!looks) return { ok: false, error: 'That file is not a readable photo. Please upload a JPG or PNG of your PAN card.' };
  return { ok: true, buffer, type, ext };
}

const maskAccount = (a) => { const s = String(a || ''); return s.length > 4 ? '•'.repeat(Math.min(8, s.length - 4)) + s.slice(-4) : s; };
const kycPrefix = (orderId) => `pay-later-kyc/${String(orderId).replace(/[^A-Za-z0-9-]/g, '')}/`;

function dueDate(deliveredAt) {
  const t = Date.parse(deliveredAt || '') || Date.now();
  return new Date(t + DUE_DAYS * 86400000).toISOString();
}

function _reset() { cache = null; at = 0; }

module.exports = {
  KEY, MIN_DELIVERED, DUE_DAYS, REVIEW_STATUS, NOT_ELIGIBLE, WHY_TEXT, CONSENT_TEXT,
  readConfig, config, setEnabled, setBook, setAllowed, isAllowed, eligibility, cartCoverage, cartItems, payLaterMeta, isPayLater,
  isUnpaidPayLater, withMeta, phone10, deliveredCount, cleanKyc, kycProblem, decodeImage,
  maskAccount, kycPrefix, dueDate, _reset,
};
