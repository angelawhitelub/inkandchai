/**
 * Netlify Function: support-ticket   (public)
 * POST /.netlify/functions/support-ticket   { action, ... }
 *
 * The customer side of the support desk at /support/.
 *
 *   create   { order_id, contact, category, message, files?:[{name,type,size}], website? }
 *              → { ticket_no, respond_by, due_at, uploads:[{key,upload_url,...}] }
 *   attach   { ticket_no, contact, files:[{key,name,type}] }   after the PUTs finish
 *   sign     { ticket_no, contact, files:[{name,type,size}] }  more upload URLs
 *   lookup   { ticket_no, contact }                            → the ticket and its timeline
 *   find     { order_id, contact }                             → tickets on an order
 *   reply    { ticket_no, contact, message, files? }           also reopens within 7 days
 *
 * The order id is mandatory and `contact` (the order's email or phone) is what
 * proves it is theirs -- the same rule as track-order. Evidence goes browser →
 * private R2 bucket directly (presigned, bound to the ticket); nothing is
 * readable without an admin session.
 *
 * `website` is a honeypot: real people never see the field, bots fill it, and
 * the answer to a bot is a convincing success that creates nothing.
 *
 * Needs sql/support_tickets.sql.
 */

const { ALLOWED_ORIGINS } = require('./ink-ai');
const A = require('./utils/support-ticket-actions');
const D = require('./utils/support-ticket-deps');

const headers = (origin) => ({
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': origin || ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
});
const reply = (res, origin) => ({ statusCode: res.status, headers: headers(origin), body: JSON.stringify(res.body) });

async function handle(event, injected) {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers(allowed), body: '' };
  if (event.httpMethod !== 'POST') return reply({ status: 405, body: { ok: false, error: 'Method Not Allowed' } }, allowed);
  // An empty Origin is a same-origin post or a curl; a foreign one is refused.
  if (origin && !allowed) return reply({ status: 403, body: { ok: false, error: 'Forbidden' } }, '');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return reply({ status: 503, body: { ok: false, error: 'Support is temporarily unavailable. Please WhatsApp us on +91 92171 75546.' } }, allowed);
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply({ status: 400, body: { ok: false, error: 'Bad request' } }, allowed); }

  const ip = event.headers?.['cf-connecting-ip'] || event.headers?.['x-forwarded-for'] || 'unknown';
  if (D.throttled(ip) || await D.overEdgeLimit(ip)) {
    return reply({ status: 429, body: { ok: false, error: 'Too many requests from here — please wait a few minutes and try again.' } }, allowed);
  }

  // Bots fill every field. Tell them it worked.
  if (body.website) return reply({ status: 200, body: { ok: true, ticket_no: 'TKT-000000', uploads: [] } }, allowed);

  const deps = injected || D.realDeps();
  try {
    switch (body.action) {
      case 'create': return reply(await A.createTicket(deps, body, { ipHash: D.ipHash(ip) }), allowed);
      case 'attach': return reply(await A.attachEvidence(deps, body), allowed);
      case 'sign': return reply(await A.signMore(deps, body), allowed);
      case 'lookup': return reply(await A.lookupTicket(deps, body), allowed);
      case 'find': return reply(await A.findTickets(deps, body), allowed);
      case 'reply': return reply(await A.customerReply(deps, body), allowed);
      default: return reply({ status: 400, body: { ok: false, error: 'Unknown action' } }, allowed);
    }
  } catch (e) {
    console.error('[support-ticket]', e);
    return reply({ status: 500, body: { ok: false, error: 'Something went wrong on our side. Please try again, or WhatsApp us on +91 92171 75546.' } }, allowed);
  }
}

// One argument only: the Worker may pass its own context as a second one, so
// the test seam is a separate export rather than a parameter of the handler.
exports.handler = (event) => handle(event);
exports.handle = handle;
