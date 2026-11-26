'use strict';

/**
 * Meta (Facebook + Instagram) ad drafts for new books (owner, 26 Nov 2026:
 * "draft paused, you switch on"). Builds ONE campaign and ONE ad set per batch,
 * with one ad per book, ALL CREATED PAUSED. Nothing here can spend money: the
 * owner reviews and activates in Ads Manager. There is no activate call in this
 * file, on purpose.
 *
 *   campaign  OUTCOME_TRAFFIC, PAUSED, no special ad category
 *   ad set    India, 18+, Advantage+ audience, landing-page views,
 *             daily budget the owner chose (only spends once activated), PAUSED
 *   ad        one per book: cover image, AI-written copy (no prices, no
 *             delivery promises, no claims), Shop Now to the product page with
 *             UTM tags, PAUSED
 *
 * Traffic, not Sales: the pixel's dataset is in a restricted category, which
 * hides Purchase/AddToCart from optimisation (see memory meta-pixel-restricted-
 * category). The owner can switch the objective in Ads Manager before activating.
 *
 * Env (Worker secrets/vars):
 *   META_ADS_TOKEN          a token with ads_management on the ad account (owner creates it)
 *   META_DRAFT_AD_ACCOUNT   ad account id for drafts (default: first of META_AD_ACCOUNT_IDS)
 *   META_PAGE_ID            the Facebook Page the ads run as (else the account's first promotable Page)
 *   META_DRAFT_DAILY_BUDGET_INR  default daily budget shown in admin (300)
 */

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v23.0'}`;
const SITE = 'https://inkandchai.in';
const MAX_BOOKS = 10;
const BUDGET = { min: 100, max: 5000, fallback: 300 };

function config(env = process.env) {
  const accounts = String(env.META_DRAFT_AD_ACCOUNT || env.META_AD_ACCOUNT_IDS || '')
    .split(/[\s,]+/).map((s) => s.replace(/^act_/, '').replace(/\D/g, '')).filter(Boolean);
  const missing = [];
  if (!env.META_ADS_TOKEN) missing.push('META_ADS_TOKEN (a token with ads_management)');
  if (!accounts.length) missing.push('META_DRAFT_AD_ACCOUNT or META_AD_ACCOUNT_IDS');
  return {
    token: env.META_ADS_TOKEN || '',
    account: accounts[0] || '',
    pageId: String(env.META_PAGE_ID || '').replace(/\D/g, ''),
    budget: clampBudget(env.META_DRAFT_DAILY_BUDGET_INR),
    missing,
    ready: !missing.length,
  };
}

function clampBudget(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return BUDGET.fallback;
  return Math.max(BUDGET.min, Math.min(BUDGET.max, n));
}

/** The product page with UTM tags, so Analytics and Net Profit can attribute the visit. */
function landingUrl(slug) {
  const q = new URLSearchParams({ utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'agent_new_books', utm_content: slug });
  return `${SITE}/product/${encodeURIComponent(slug)}/?${q}`;
}

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…`;
};

// Words an ad must not say: prices and offers change weekly (weekly price swing,
// coupons), delivery depends on the courier, and "best"/"#1" are claims.
const BANNED = /₹|\brs\.?\s?\d|\bprice\b|\bdiscount|\boff\b|\bsale\b|\bfree\b|\bdeliver|\bcod\b|cash on delivery|\bbest\b|#1|\bguarantee|\blimited\b|\bhurry\b/i;

/** Plain copy from the listing itself, used when OpenAI is unavailable or its copy breaks a rule. */
function templateCopy(p) {
  const first = String(p.description || '').replace(/[#*_>`-]+/g, ' ').replace(/\s+/g, ' ').trim()
    .split(/(?<=[.!?])\s/).find((s) => s.length > 30 && !BANNED.test(s)) || '';
  // Listing titles already read "Title by Author".
  const bare = String(p.title || '').replace(/\s+by\s+.+$/i, '').trim() || p.title;
  const named = p.author && !String(p.title || '').toLowerCase().includes(String(p.author).toLowerCase()) ? `${p.title} by ${p.author}` : p.title;
  return {
    primary_text: clip(`${named}. ${first}`.trim(), 220),
    headline: clip(bare, 40),
    description: clip(p.author ? `by ${p.author}` : 'Ink & Chai', 30),
    source: 'template',
  };
}

const COPY_PROMPT = `You write Facebook/Instagram ad copy for Ink & Chai, an Indian online bookstore.
Return ONLY JSON: {"primary_text": "...", "headline": "...", "description": "..."}
- primary_text: 90-200 characters. Why a reader would want THIS book. Indian English. At most one emoji.
- headline: at most 40 characters. Usually the book's title.
- description: at most 30 characters. Usually "by <author>".
Never mention prices, discounts, offers, sales, free anything, delivery, COD or stock.
Never claim "best", "#1", awards, bestseller status or reviews. Never address the reader's
personal traits, health, finances or problems ("Are you anxious?") -- Meta rejects that.`;

async function draftCopy(p, { apiKey, model, fetchImpl = fetch } = {}) {
  const fallback = templateCopy(p);
  if (!apiKey) return fallback;
  try {
    const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'gpt-4.1-mini',
        response_format: { type: 'json_object' },
        temperature: 0.6,
        max_tokens: 300,
        messages: [
          { role: 'system', content: COPY_PROMPT },
          { role: 'user', content: `Title: ${p.title}\nAuthor: ${p.author || 'unknown'}\nCategory: ${p.category || ''}\nAbout the book:\n${String(p.description || '').slice(0, 1500)}` },
        ],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ...fallback, note: `OpenAI ${res.status}` };
    const out = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    const copy = { primary_text: clip(out.primary_text, 220), headline: clip(out.headline, 40), description: clip(out.description, 30), source: 'ai' };
    if (!copy.primary_text || !copy.headline || BANNED.test(`${copy.primary_text} ${copy.headline} ${copy.description}`)) {
      return { ...fallback, note: 'AI copy broke a rule; used the listing text' };
    }
    return copy;
  } catch (e) {
    return { ...fallback, note: e.message };
  }
}

/** What would be created, without any Meta call. */
function plan(products, { budget, now = new Date() } = {}) {
  const day = now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
  return {
    campaign: { name: `Ink & Chai · New books (agent) · ${day}`, objective: 'OUTCOME_TRAFFIC', status: 'PAUSED' },
    adset: {
      name: `India 18+ · Advantage+ audience · ${products.length} book${products.length === 1 ? '' : 's'}`,
      daily_budget_inr: budget, optimization_goal: 'LANDING_PAGE_VIEWS', status: 'PAUSED',
      targeting: { geo_locations: { countries: ['IN'] }, age_min: 18, targeting_automation: { advantage_audience: 1 } },
    },
    ads: products.map((p) => ({
      slug: p.slug, title: p.title, image_url: p.image_url, link: landingUrl(p.slug),
      ...p.copy, status: 'PAUSED',
    })),
  };
}

// ── Graph API ──────────────────────────────────────────────────────────────

async function graphPost(path, params, { token, fetchImpl = fetch }) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const res = await fetchImpl(`${GRAPH}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    throw new Error(`Meta ${path.split('/').pop()}: ${e.error_user_msg || e.message || 'HTTP ' + res.status}${e.code ? ` (code ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''})` : ''}`);
  }
  return data;
}

async function graphGet(path, { token, fetchImpl = fetch }) {
  const res = await fetchImpl(`${GRAPH}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Meta ${path}: ${(data.error && data.error.message) || 'HTTP ' + res.status}`);
  return data;
}

/** The Page the ads run as: META_PAGE_ID, else the ad account's first promotable Page. */
async function resolvePage(cfg, deps) {
  if (cfg.pageId) return cfg.pageId;
  const data = await graphGet(`act_${cfg.account}/promote_pages?fields=id,name&limit=5`, { token: cfg.token, ...deps });
  const page = (data.data || [])[0];
  if (!page) throw new Error('No Facebook Page can be promoted from this ad account. Set META_PAGE_ID.');
  return page.id;
}

async function uploadImage(url, cfg, deps) {
  const res = await (deps.fetchImpl || fetch)(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`cover image HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer()).toString('base64');
  const data = await graphPost(`act_${cfg.account}/adimages`, { bytes }, { token: cfg.token, ...deps });
  const first = Object.values(data.images || {})[0];
  if (!first || !first.hash) throw new Error('Meta returned no image hash');
  return first.hash;
}

/**
 * Create the paused campaign, ad set and one ad per book.
 * → { campaign_id, adset_id, page_id, ads: [{ slug, ok, ad_id?, creative_id?, image_hash?, error? }] }
 * A book that fails (image, creative) is reported and the others carry on.
 */
async function createPaused(products, cfg, { budget, fetchImpl = fetch, now = new Date() } = {}) {
  if (!cfg.ready) throw new Error(`Meta ads are not set up: ${cfg.missing.join('; ')}`);
  const deps = { fetchImpl };
  const p = plan(products, { budget, now });
  const pageId = await resolvePage(cfg, deps);
  const call = (path, params) => graphPost(path, params, { token: cfg.token, fetchImpl });

  const campaign = await call(`act_${cfg.account}/campaigns`, {
    name: p.campaign.name, objective: p.campaign.objective, status: 'PAUSED',
    special_ad_categories: [], buying_type: 'AUCTION', is_adset_budget_sharing_enabled: false,
  });
  const adset = await call(`act_${cfg.account}/adsets`, {
    name: p.adset.name, campaign_id: campaign.id, status: 'PAUSED',
    daily_budget: Math.round(budget * 100),     // account currency's minor unit: paise
    billing_event: 'IMPRESSIONS', optimization_goal: 'LANDING_PAGE_VIEWS',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP', destination_type: 'WEBSITE',
    targeting: p.adset.targeting,
  });

  const ads = [];
  for (const ad of p.ads) {
    try {
      if (!ad.image_url) throw new Error('the book has no cover image');
      const imageHash = await uploadImage(ad.image_url, cfg, deps);
      const creative = await call(`act_${cfg.account}/adcreatives`, {
        name: `${ad.title} · creative`,
        object_story_spec: {
          page_id: pageId,
          link_data: {
            link: ad.link, message: ad.primary_text, name: ad.headline, description: ad.description,
            image_hash: imageHash, call_to_action: { type: 'SHOP_NOW', value: { link: ad.link } },
          },
        },
      });
      const made = await call(`act_${cfg.account}/ads`, {
        name: ad.title, adset_id: adset.id, creative: { creative_id: creative.id }, status: 'PAUSED',
      });
      ads.push({ slug: ad.slug, ok: true, ad_id: made.id, creative_id: creative.id, image_hash: imageHash });
    } catch (e) {
      ads.push({ slug: ad.slug, ok: false, error: e.message });
    }
  }
  return { campaign_id: campaign.id, adset_id: adset.id, page_id: pageId, plan: p, ads };
}

/** Ads Manager link straight to the paused campaign. */
const adsManagerUrl = (account, campaignId) =>
  `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${account}&selected_campaign_ids=${campaignId}`;

module.exports = {
  MAX_BOOKS, BUDGET, BANNED, config, clampBudget, landingUrl, templateCopy, draftCopy, plan, createPaused, adsManagerUrl,
};
