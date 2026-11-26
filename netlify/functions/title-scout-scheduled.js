/**
 * Scheduled + admin function: title-scout-scheduled
 *
 * Nightly at 03:00 IST (jobs.toml), its own cron slot. Drafts NEW books into the
 * same review queue as the bestseller agent (bestseller_candidates), from:
 *   - customer requests we do not list (website + WhatsApp), matched to an
 *     Indian edition through Amazon.in search;
 *   - other books by authors who already sell well here;
 *   - Amazon.in "Hot New Releases" for the nightly genres.
 * Then re-scores every pending draft (utils/title-scout scoreCandidate) and
 * emails the owner the day's best drafts. Publishes nothing: every draft waits
 * for the owner's Approve in admin → 📈 Bestsellers (owner, 26 Nov 2026).
 *
 * Admin: POST { limit? (≤10), dry_run? } runs the same pass now.
 * The cron path is the event without rawUrl, as in bestseller-agent-scheduled.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const agent = require('./utils/bestseller-agent');
const scout = require('./utils/title-scout');
const { loadCatalogue, startRun, finishRun } = require('./bestseller-agent-scheduled');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const HTTP_LIMIT = 10;
const IST = 5.5 * 3600e3;

async function run({ supabase, store, limit, dryRun, fromCron, fetchImpl = fetch, now = Date.now(), sendEmail, readSales }) {
  const catalogue = await loadCatalogue(supabase);
  const demand = await scout.requestDemand(supabase, { now });
  const sales = await readSales().catch(() => null);
  const units = scout.authorUnits(sales, catalogue);

  const limits = fromCron ? scout.LIMITS : { ...scout.LIMITS, requests: Math.min(6, limit), authors: 1, drafts: limit };
  const found = await scout.findSeeds({ supabase, catalogue, demand, units, store, fetchImpl, now, limits, pauseMs: 600 });

  const summary = await agent.runAgent({
    supabase,
    catalogue,
    fetchImpl,
    openaiKey: dryRun ? null : process.env.OPENAI_API_KEY,
    openaiModel: process.env.OPENAI_BESTSELLER_MODEL || 'gpt-4.1-mini',
  }, { limit: limits.drafts, dryRun, kind: 'new-releases', seeds: found.seeds, noLists: !fromCron, refreshKnown: false });

  const rescore = dryRun ? { skipped: 'dry run' } : await scout.rescorePending(supabase, { demand, units, now: new Date(now), catalogue });

  let digest = 'not sent';
  if (fromCron && !dryRun) digest = await sendDigest({ store, summary, rescore, now, sendEmail, switchedOff: found.switched_off });

  return {
    scout: {
      open_requests: demand.length, requests_searched: found.searched, requests_matched: found.matched,
      requests_unmatched: found.unmatched, requests_already_listed: found.listed, switched_off: found.switched_off, authors: found.authors,
      seeds: found.seeds.length, errors: found.errors,
    },
    ...summary,
    errors: [...found.errors, ...(summary.errors || [])],
    rescore: { pending: rescore.pending, changed: rescore.changed, now_listed: rescore.now_listed, skipped: rescore.skipped },
    digest,
  };
}

/** One email a day to the owner with the best drafts, when there is anything to review. */
async function sendDigest({ store, summary, rescore, now, sendEmail, switchedOff = [] }) {
  const to = process.env.TITLE_SCOUT_EMAIL || process.env.STORE_OWNER_EMAIL;
  if (!to) return 'no recipient';
  const top = (rescore.top || []).filter((c) => c.score > 0);
  if (!top.length) return 'nothing to review';
  const day = new Date(now + IST).toISOString().slice(0, 10);
  const last = await store.get(scout.DIGEST_KEY, { type: 'json' }).catch(() => null);
  if (last && last.day === day) return 'already sent today';
  await store.setJSON(scout.DIGEST_KEY, { day, at: new Date(now).toISOString() }).catch(() => {});
  const send = sendEmail || require('./utils/email').sendEmail;
  const r = await send({
    to,
    subject: `📚 ${summary.drafted || 0} new books drafted · ${rescore.pending} waiting for review`,
    html: scout.digestHtml({ top, pending: rescore.pending, drafted: summary.drafted || 0, switchedOff, adminUrl: 'https://inkandchai.in/admin/#bestsellers' }),
  }).catch((e) => ({ ok: false, error: e.message }));
  return r && r.ok === false ? `failed: ${r.error || 'email refused'}` : 'sent';
}

exports.handler = async (event = {}) => {
  const fromCron = !event.rawUrl;
  if (!fromCron) {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
    const blocked = requireAdmin(event, CORS);
    if (blocked) return blocked;
  }
  let body = {};
  if (!fromCron) {
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  }
  const dryRun = !fromCron && !!body.dry_run;
  const limit = fromCron ? scout.LIMITS.drafts : Math.max(1, Math.min(HTTP_LIMIT, Number(body.limit) || HTTP_LIMIT));

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { getStore } = require('@netlify/blobs');
  const store = getStore('catalog');
  const trigger = fromCron ? 'scout-cron' : 'scout-admin';
  const runId = dryRun ? null : await startRun(supabase, trigger);

  try {
    const out = await run({
      supabase, store, limit, dryRun, fromCron,
      readSales: () => require('./utils/lifetime-sales').readLifetimeSales(),
    });
    if (!dryRun) {
      await finishRun(supabase, runId, trigger, { ...out, drafts: (out.drafts || []).slice(0, 50), skips: (out.skips || []).slice(0, 50) });
    }
    console.log(`[title-scout] ${trigger} drafted=${out.drafted} seeds=${out.scout.seeds} requests=${out.scout.requests_matched}/${out.scout.requests_searched} rescored=${out.rescore.changed} digest=${out.digest}`);
    return json(200, { ok: true, ...out });
  } catch (e) {
    console.error('[title-scout]', e);
    if (!dryRun) await finishRun(supabase, runId, trigger, { error: e.message, errors: [e.message] });
    return json(500, { error: e.message });
  }
};

exports._test = { run, sendDigest };
