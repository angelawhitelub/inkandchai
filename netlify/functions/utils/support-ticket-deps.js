'use strict';

/** The real database, mailers and private bucket behind support-ticket-actions. */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const bindings = require('../../../worker/shims/runtime-bindings');
const { r2PresignPut, r2HeadObject, r2GetObject, r2EbookConfig, r2EbookConfigured } = require('./r2-put');
const T = require('./support-ticket');

function whatsappOn(env = process.env) {
  return String(env.SUPPORT_TICKET_WHATSAPP || '').trim().toLowerCase() === 'on';
}

function realDeps(env = process.env) {
  const cfg = r2EbookConfig(env);
  return {
    db: createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY),
    sendEmail: (m) => require('./email').sendEmail(m),
    sendWhatsApp: (m) => require('./whatsapp').sendWhatsApp(m),
    whatsappOn: whatsappOn(env),
    ownerEmail: T.ownerEmail(env),
    r2: {
      configured: r2EbookConfigured(env),
      // The bucket has no public base; the placeholder only satisfies the signer
      // and its publicUrl is discarded. Evidence is read back through an
      // admin-only endpoint, never from a URL.
      presign: (key, type) => r2PresignPut({ ...cfg, publicBase: 'https://private.invalid' }, { key, contentType: type, expiresIn: 900 }).uploadUrl,
      head: (key) => r2HeadObject(cfg, key),
      get: (key) => r2GetObject(cfg, key),
    },
  };
}

// ── Abuse limits for the public endpoint ───────────────────────────────────

const HITS = new Map();
const LOCAL_LIMIT = 8;
const LOCAL_WINDOW_MS = 10 * 60 * 1000;

/** Isolate-local backstop. */
function throttled(ip, now = Date.now()) {
  const hits = (HITS.get(ip) || []).filter((t) => now - t < LOCAL_WINDOW_MS);
  hits.push(now);
  HITS.set(ip, hits);
  if (HITS.size > 5000) HITS.clear();
  return hits.length > LOCAL_LIMIT;
}

/**
 * The exact limit: the same Durable Object Ink AI uses, under its OWN key so a
 * customer chatting with the assistant cannot lock themselves out of raising a
 * ticket. Returns false when the binding is absent (tests, local).
 */
async function overEdgeLimit(ip, limit = 12, windowSec = 600) {
  const ns = bindings.get('INK_AI_LIMIT');
  if (!ns || typeof ns.idFromName !== 'function') return false;
  const key = `ticket:${ip}`;
  try {
    const stub = ns.get(ns.idFromName(key));
    const res = await stub.fetch(`https://ticket-limit/?key=${encodeURIComponent(key)}&limit=${limit}&window=${windowSec}`);
    return (await res.json()).allowed === false;
  } catch (e) {
    console.warn('[support-ticket] limiter:', e.message);
    return false;
  }
}

function ipHash(ip, env = process.env) {
  return crypto.createHash('sha256').update(`${ip}|${env.ADMIN_TOKEN_SECRET || env.ADMIN_SECRET || ''}`).digest('hex').slice(0, 16);
}

module.exports = { realDeps, whatsappOn, throttled, overEdgeLimit, ipHash };
