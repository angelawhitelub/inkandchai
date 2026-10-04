/**
 * Scheduled + admin function: bestseller-agent-scheduled
 *
 * Daily (jobs.toml): reads the Amazon.in bestseller lists, and drafts a listing
 * for each top-ranked book we do not sell yet into bestseller_candidates, for
 * the admin to approve or reject. Publishes nothing. See utils/bestseller-agent.
 *
 * Also callable from the admin "Bestsellers" tab:
 *   POST { dry_run?, limit?, lists?, pages? }   (admin; lists = genre ids, pages 2 = top 100)
 * An HTTP call is capped at HTTP_LIMIT drafts so it stays well inside a
 * request's CPU budget; the panel calls again for more.
 *
 * The cron path is told apart by the event the Worker's scheduler builds, which
 * has no rawUrl. Every HTTP event has one, so an anonymous request can never
 * pass for the scheduler, whatever headers it sends.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const agent = require('./utils/bestseller-agent');
const catalogIndex = require('../../data/catalog-index.json');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const HTTP_LIMIT = 10;

/** Everything we already list: the baked catalogue and admin-created products. */
async function loadCatalogue(supabase) {
  const seen = new Set();
  const entries = [];
  for (const b of Object.values(catalogIndex || {})) {
    if (!b || !b.title || seen.has(b.slug)) continue;
    seen.add(b.slug);
    entries.push({ title: b.title, slug: b.slug, source: 'catalogue', weak: /preloved/i.test(`${b.title} ${b.slug}`) });
  }
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await supabase.from('custom_products')
      .select('slug, title, author, isbn, is_active')
      .order('slug', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`custom_products: ${error.message}`);
    for (const p of data || []) {
      entries.push({ title: p.title, author: p.author, slug: p.slug, isbn: p.isbn, source: 'custom', weak: p.is_active === false || /preloved/i.test(`${p.title} ${p.slug}`) });
    }
    if (!data || data.length < 1000) break;
  }
  return entries;
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

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const limit = fromCron ? agent.DEFAULT_LIMIT : Math.max(0, Math.min(HTTP_LIMIT, Number(body.limit ?? HTTP_LIMIT) || 0));
  const dryRun = !fromCron && !!body.dry_run;

  try {
    const catalogue = await loadCatalogue(supabase);
    const summary = await agent.runAgent({
      supabase,
      catalogue,
      openaiKey: dryRun ? null : process.env.OPENAI_API_KEY,
      openaiModel: process.env.OPENAI_BESTSELLER_MODEL || 'gpt-4.1-mini',
    }, { limit, dryRun, lists: Array.isArray(body.lists) ? body.lists.map(String) : null, pages: fromCron ? 1 : body.pages });

    if (!dryRun) {
      const { error } = await supabase.from('bestseller_agent_runs').insert({
        trigger: fromCron ? 'cron' : 'admin',
        started_at: summary.started_at,
        finished_at: summary.finished_at,
        summary: { ...summary, drafts: summary.drafts.slice(0, 50), skips: summary.skips.slice(0, 50) },
      });
      if (error) console.warn('[bestseller-agent] run log:', error.message);
    }
    console.log(`[bestseller-agent] ${fromCron ? 'cron' : 'admin'} drafted=${summary.drafted} in_catalogue=${summary.in_catalogue} skipped=${summary.skipped} failed=${summary.failed} remaining=${summary.remaining}`);
    return json(200, { ok: true, catalogue_titles: catalogue.length, ...summary });
  } catch (e) {
    console.error('[bestseller-agent]', e);
    return json(500, { error: e.message });
  }
};
