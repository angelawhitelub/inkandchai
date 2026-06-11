/**
 * spam-filter.js — shared lead-quality guard for abandoned checkouts.
 *
 * Bots and keyboard-mash fills were polluting the abandoned-checkout list and
 * burning real money: every junk lead triggered a WhatsApp template (~₹0.91)
 * and an email. This module decides whether a captured lead is real enough to
 * (a) save, (b) message on WhatsApp, and (c) email.
 *
 * Observed spam in production:
 *   - name "John Smith", phone 6502530000 (Google's HQ test number),
 *     email johnsmithNNN@storebotmail.joonix.net (a Google bot domain)
 *   - keyboard mash: names like "Bbbbbvbbg…", phones "ff" / "^÷•^•.¡€€€×",
 *     emails like "…." or ","
 */

// Domains used by bots / disposable-mail / testing — never message these.
const BLOCKED_EMAIL_DOMAINS = new Set([
  'joonix.net', 'storebotmail.joonix.net',
  'mailinator.com', 'example.com', 'example.org', 'test.com',
  'tempmail.com', 'guerrillamail.com', 'sharklasers.com',
  'trashmail.com', 'yopmail.com', '10minutemail.com',
]);

// Phones that are obviously not a real Indian customer.
const BLOCKED_PHONES = new Set([
  '6502530000',   // Google HQ / Search Console test number (the bot's signature)
  '5555555555', '1234567890', '0123456789', '9876543210',
  '0000000000', '1111111111',
]);

function normalizeIndianPhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (p.length === 12 && p.startsWith('91')) p = p.slice(2);
  if (p.length === 11 && p.startsWith('0'))  p = p.slice(1);
  return p;
}

// A genuine Indian mobile: 10 digits, starts 6-9, not a blocked/repeated pattern.
function isValidIndianMobile(raw) {
  const p = normalizeIndianPhone(raw);
  if (p.length !== 10) return false;
  if (!/^[6-9]/.test(p)) return false;
  if (/^(\d)\1{9}$/.test(p)) return false;     // all identical digits
  if (BLOCKED_PHONES.has(p)) return false;
  return true;
}

function emailDomain(e) {
  const m = String(e || '').toLowerCase().trim().match(/@([^@\s]+)$/);
  return m ? m[1] : '';
}

// A usable email: passes a basic shape check and isn't a bot/disposable domain.
function isValidEmail(e) {
  const v = String(e || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(v)) return false;
  const d = emailDomain(v);
  if (!d || d.length < 4) return false;
  if (BLOCKED_EMAIL_DOMAINS.has(d)) return false;
  if (d.endsWith('.joonix.net')) return false;   // any Google bot subdomain
  return true;
}

// Keyboard-mash / nonsense name detector.
function looksLikeGibberishName(name) {
  const n = String(name || '').trim();
  if (!n) return false;                  // empty is handled elsewhere, not "gibberish"
  if (n.length < 2) return true;
  const letters = n.replace(/[^a-zA-ZÀ-ɏऀ-ॿ]/g, ''); // latin + accents + devanagari
  // Mostly symbols/numbers → junk
  if (letters.length < n.length * 0.5) return true;
  // Long stretch of consonants with no vowel → "Bbbbvbbg", "rrvffctrfcggg"
  if (letters.length >= 5 && /^[a-zA-Z]+$/.test(letters) && !/[aeiouAEIOU]/.test(letters)) return true;
  // Any character repeated 5+ times in a row → "Bbbbbb…", "iiiii"
  if (/(.)\1{4,}/.test(n)) return true;
  return false;
}

/**
 * Decide if a captured lead is spam (should not be saved, messaged, or emailed).
 * Returns { spam: boolean, reason: string }.
 *
 * A lead is spam when it has NO usable contact channel, OR it carries a clear
 * bot fingerprint, OR the name is gibberish and the phone isn't a real mobile.
 */
function classifyLead({ name, email, phone } = {}) {
  const validPhone = isValidIndianMobile(phone);
  const validEmail = isValidEmail(email);

  // Hard bot signals — block regardless of anything else.
  if (emailDomain(email).endsWith('joonix.net')) return { spam: true, reason: 'bot_email_domain' };
  if (BLOCKED_PHONES.has(normalizeIndianPhone(phone))) return { spam: true, reason: 'bot_phone' };

  // No way to actually reach this person → worthless + likely junk.
  if (!validPhone && !validEmail) return { spam: true, reason: 'no_usable_contact' };

  // Gibberish name with no valid phone → keyboard mash.
  if (looksLikeGibberishName(name) && !validPhone) return { spam: true, reason: 'gibberish_name' };

  return { spam: false, reason: 'ok' };
}

module.exports = {
  classifyLead,
  isValidIndianMobile,
  isValidEmail,
  looksLikeGibberishName,
  normalizeIndianPhone,
};
