const test = require('node:test');
const assert = require('node:assert');
const M = require('./meta-ad-draft');
const { _test: E } = require('../meta-ad-drafts');

const BOOK = {
  slug: 'fluent-python-by-luciano-ramalho', title: 'Fluent Python by Luciano Ramalho', author: 'Luciano Ramalho',
  category: 'Non-Fiction', image_url: 'https://img.example/fp.webp', is_active: true,
  description: '## About\nUp to 40% off today! Fluent Python takes you beyond the basics into idiomatic, effective Python code.',
};

test('config: nothing can be created without a write token', () => {
  const none = M.config({ META_AD_ACCOUNT_IDS: 'act_111,222' });
  assert.equal(none.ready, false);
  assert.equal(none.account, '111');
  assert.match(none.missing[0], /META_ADS_TOKEN/);
  assert.equal(M.config({ META_ADS_TOKEN: 't', META_DRAFT_AD_ACCOUNT: '333', META_AD_ACCOUNT_IDS: '111' }).account, '333');
  assert.equal(M.clampBudget(20), 100);
  assert.equal(M.clampBudget(99999), 5000);
  assert.equal(M.clampBudget('abc'), 300);
});

test('copy: never quotes prices or offers; falls back to the listing when AI breaks a rule', async () => {
  const t = M.templateCopy(BOOK);
  assert.doesNotMatch(t.primary_text, M.BANNED);
  assert.match(t.primary_text, /^Fluent Python by Luciano Ramalho\. Fluent Python takes you/);
  const ai = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ primary_text: 'Flat 40% off this week only!', headline: 'Fluent Python', description: 'by Ramalho' }) } }] }) });
  const c = await M.draftCopy(BOOK, { apiKey: 'k', fetchImpl: ai });
  assert.equal(c.source, 'template');
  const good = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ primary_text: 'Write Python the way experienced developers do, with clear examples on every page.', headline: 'Fluent Python', description: 'by Luciano Ramalho' }) } }] }) });
  assert.equal((await M.draftCopy(BOOK, { apiKey: 'k', fetchImpl: good })).source, 'ai');
});

test('plan: everything PAUSED, India, traffic, UTM-tagged product link', () => {
  const p = M.plan([{ ...BOOK, copy: M.templateCopy(BOOK) }], { budget: 300, now: new Date('2026-11-26T10:00:00Z') });
  assert.equal(p.campaign.status, 'PAUSED');
  assert.equal(p.adset.status, 'PAUSED');
  assert.equal(p.ads[0].status, 'PAUSED');
  assert.deepEqual(p.adset.targeting.geo_locations.countries, ['IN']);
  assert.equal(p.campaign.objective, 'OUTCOME_TRAFFIC');
  assert.equal(p.ads[0].link, 'https://inkandchai.in/product/fluent-python-by-luciano-ramalho/?utm_source=facebook&utm_medium=paid_social&utm_campaign=agent_new_books&utm_content=fluent-python-by-luciano-ramalho');
});

test('createPaused: every object is sent with status PAUSED; a failing book does not stop the rest', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    if (!/graph\.facebook\.com/.test(url)) {
      if (/broken/.test(url)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('img').buffer };
    }
    const path = url.split('/v')[1].split('/').slice(1).join('/');
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    calls.push({ path, body });
    const reply = (o) => ({ ok: true, status: 200, json: async () => o });
    if (/promote_pages/.test(path)) return reply({ data: [{ id: '555', name: 'Ink & Chai' }] });
    if (/campaigns$/.test(path)) return reply({ id: 'c1' });
    if (/adsets$/.test(path)) return reply({ id: 's1' });
    if (/adimages$/.test(path)) return reply({ images: { bytes: { hash: 'h1' } } });
    if (/adcreatives$/.test(path)) return reply({ id: 'cr1' });
    if (/ads$/.test(path)) return reply({ id: 'ad1' });
    return reply({});
  };
  const cfg = M.config({ META_ADS_TOKEN: 't', META_AD_ACCOUNT_IDS: '111' });
  const books = [{ ...BOOK, copy: M.templateCopy(BOOK) }, { ...BOOK, slug: 'b2', image_url: 'https://img.example/broken.webp', copy: M.templateCopy(BOOK) }];
  const out = await M.createPaused(books, cfg, { budget: 250, fetchImpl });
  assert.equal(out.campaign_id, 'c1');
  assert.equal(out.ads[0].ok, true);
  assert.equal(out.ads[1].ok, false);
  const statuses = calls.filter((c) => c.body.status).map((c) => [c.path.split('/').pop(), c.body.status]);
  assert.deepEqual(statuses, [['campaigns', 'PAUSED'], ['adsets', 'PAUSED'], ['ads', 'PAUSED']]);
  assert.equal(calls.find((c) => /adsets$/.test(c.path)).body.daily_budget, '25000', 'paise');
  assert.equal(JSON.parse(calls.find((c) => /adcreatives$/.test(c.path)).body.object_story_spec).page_id, '555');
  assert.ok(!calls.some((c) => /status/.test(c.path) || c.body.status === 'ACTIVE'), 'nothing is ever activated');
});

test('endpoint: preview works without Meta; create refuses until set up; switched-off books refused', async () => {
  const products = [BOOK, { ...BOOK, slug: 'off-book', title: 'Off Book', is_active: false }];
  const supabase = {
    from: () => ({
      select: () => ({ in: async (_c, slugs) => ({ data: products.filter((p) => slugs.includes(p.slug)), error: null }) }),
      insert: async () => ({ error: null }),
    }),
  };
  const deps = { requireAdmin: () => null, supabase, config: M.config({ META_AD_ACCOUNT_IDS: '111' }), draftCopy: async (p) => M.templateCopy(p) };
  const post = (body) => E.handle({ httpMethod: 'POST', body: JSON.stringify(body) }, deps);
  const pv = await post({ action: 'preview', slugs: [BOOK.slug] });
  assert.equal(pv.statusCode, 200);
  const d = JSON.parse(pv.body);
  assert.equal(d.configured, false);
  assert.equal(d.plan.ads.length, 1);
  assert.equal((await post({ action: 'create', slugs: [BOOK.slug] })).statusCode, 409);
  assert.equal((await post({ action: 'preview', slugs: ['off-book'] })).statusCode, 409);
  assert.equal((await post({ action: 'preview', slugs: ['nope'] })).statusCode, 404);
});
