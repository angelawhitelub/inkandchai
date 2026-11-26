/**
 * Netlify Function: meta-ad-drafts   (owner only)
 *
 * GET                                   → { configured, missing, account, budget, drafts }
 * POST { action:'preview', slugs }      → the campaign / ad set / ads that WOULD be made,
 *                                         with the ad copy. No Meta call. (the default)
 * POST { action:'create', slugs, daily_budget_inr }
 *                                       → creates them in Meta, ALL PAUSED, and records
 *                                         them in meta_ad_drafts. Spends nothing until
 *                                         the owner activates them in Ads Manager.
 *
 * Owner rule (26 Nov 2026): the agent drafts ads paused; the owner switches them on.
 * There is deliberately no activate action. Not in STAFF_ENDPOINT_PERMISSIONS, so
 * support staff cannot reach it. See utils/meta-ad-draft.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const M = require('./utils/meta-ad-draft');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

async function loadProducts(supabase, slugs) {
  const { data, error } = await supabase.from('custom_products')
    .select('slug, title, author, category, description, image_url, is_active').in('slug', slugs);
  if (error) throw new Error(`custom_products: ${error.message}`);
  const bySlug = new Map((data || []).map((p) => [p.slug, p]));
  return slugs.map((s) => bySlug.get(s) || { slug: s, missing: true });
}

async function handle(event, deps = {}) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = (deps.requireAdmin || requireAdmin)(event, CORS);
  if (blocked) return blocked;

  const cfg = deps.config || M.config();
  const supabase = deps.supabase || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase.from('meta_ad_drafts').select('*').order('id', { ascending: false }).limit(100);
    return json(200, {
      configured: cfg.ready, missing: cfg.missing, account: cfg.account || null, budget: cfg.budget,
      budget_range: M.BUDGET, drafts: error ? [] : data || [],
      table_missing: !!(error && /meta_ad_drafts/.test(error.message || '')),
    });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const slugs = [...new Set((Array.isArray(body.slugs) ? body.slugs : []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean))];
  if (!slugs.length) return json(400, { error: 'Pick at least one listed book.' });
  if (slugs.length > M.MAX_BOOKS) return json(400, { error: `At most ${M.MAX_BOOKS} books per ad set.` });
  const action = body.action === 'create' ? 'create' : 'preview';
  const budget = M.clampBudget(body.daily_budget_inr ?? cfg.budget);

  const products = await loadProducts(supabase, slugs);
  const missing = products.filter((p) => p.missing).map((p) => p.slug);
  if (missing.length) return json(404, { error: `Not an admin-listed book: ${missing.join(', ')}` });
  const off = products.filter((p) => p.is_active === false).map((p) => p.title);
  if (off.length) return json(409, { error: `Switched off on the site, so an ad would lead nowhere: ${off.join(', ')}` });

  for (const p of products) {
    p.copy = await (deps.draftCopy || M.draftCopy)(p, { apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_BESTSELLER_MODEL });
  }

  if (action === 'preview') {
    return json(200, { ok: true, configured: cfg.ready, missing: cfg.missing, plan: M.plan(products, { budget }) });
  }
  if (!cfg.ready) return json(409, { error: `Meta ads are not set up yet: ${cfg.missing.join('; ')}` });

  const made = await (deps.createPaused || M.createPaused)(products, cfg, { budget });
  const rows = made.ads.map((a) => {
    const p = products.find((x) => x.slug === a.slug) || {};
    return {
      slug: a.slug, candidate_id: body.candidate_ids && body.candidate_ids[a.slug] || null, title: p.title,
      ad_account_id: cfg.account, campaign_id: made.campaign_id, adset_id: made.adset_id,
      creative_id: a.creative_id || null, ad_id: a.ad_id || null, image_hash: a.image_hash || null,
      headline: p.copy && p.copy.headline, primary_text: p.copy && p.copy.primary_text, description: p.copy && p.copy.description,
      link: M.landingUrl(a.slug), daily_budget_inr: budget, status: a.ok ? 'paused' : 'failed', error: a.error || null,
    };
  });
  const { error } = await supabase.from('meta_ad_drafts').insert(rows);
  if (error) console.warn('[meta-ad-drafts] record:', error.message);
  return json(200, {
    ok: true, campaign_id: made.campaign_id, adset_id: made.adset_id,
    ads_manager: M.adsManagerUrl(cfg.account, made.campaign_id),
    ads: made.ads, recorded: !error,
  });
}

exports.handler = async (event) => {
  try { return await handle(event); }
  catch (e) {
    console.error('[meta-ad-drafts]', e);
    return json(500, { error: e.message });
  }
};
exports._test = { handle };
