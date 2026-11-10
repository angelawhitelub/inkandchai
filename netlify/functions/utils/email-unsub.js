'use strict';

/**
 * Marketing-email unsubscribes (new-title alerts by email, 10 Nov 2026).
 *
 * Every marketing email carries a signed link to /.netlify/functions/
 * email-unsubscribe. The signature (HMAC over the address) means only the
 * person we emailed can unsubscribe that address, and nobody can probe or
 * flip other people's settings.
 *
 * Storage: one key per address in the blob store 'email-unsub' (KV on
 * Cloudflare), named by a hash of the address so no address is stored in
 * plain text and two unsubscribes can never overwrite each other. A send
 * lists the store once and skips every hashed address in it.
 */

const crypto = require('crypto');

let getStore = null;
try { ({ getStore } = require('@netlify/blobs')); } catch { getStore = null; }

const STORE = 'email-unsub';
const LABEL = 'email-unsub:v1:';
const SITE = 'https://inkandchai.in';

const normEmail = (e) => String(e || '').trim().toLowerCase();
const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normEmail(e));

function hashEmail(email) {
  return crypto.createHash('sha256').update(normEmail(email)).digest('hex').slice(0, 40);
}

function secret() {
  return process.env.EMAIL_UNSUB_SECRET || process.env.ADMIN_SECRET || '';
}

function signEmail(email) {
  const key = secret();
  const e = normEmail(email);
  if (!key || !e) return '';
  return crypto.createHmac('sha256', key).update(LABEL + e).digest('base64url').slice(0, 24);
}

function verifyEmail(email, token) {
  const want = signEmail(email);
  const got = String(token || '').trim();
  if (!want || want.length !== got.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got)); } catch { return false; }
}

/** The link printed in every marketing email; '' when no secret is configured. */
function unsubscribeUrl(email) {
  const t = signEmail(email);
  if (!t) return '';
  return `${SITE}/.netlify/functions/email-unsubscribe?e=${Buffer.from(normEmail(email)).toString('base64url')}&t=${t}`;
}

function store(deps = {}) {
  if (deps.store) return deps.store;
  if (!getStore) throw new Error('blob store not available');
  return getStore(STORE);
}

async function markUnsubscribed(email, deps = {}) {
  await store(deps).setJSON(hashEmail(email), { at: new Date().toISOString() });
}

/** Hashes of every unsubscribed address. Throws if the store cannot be read. */
async function unsubscribedHashes(deps = {}) {
  const out = await store(deps).list();
  return new Set((out && out.blobs ? out.blobs : []).map((b) => b.key));
}

module.exports = { STORE, normEmail, isEmail, hashEmail, signEmail, verifyEmail, unsubscribeUrl, markUnsubscribed, unsubscribedHashes };
