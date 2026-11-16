/**
 * Netlify Function: admin-reading-lists   (admin, owner only)
 *
 * GET  -> the generated reading lists, topic queue, settings and last run.
 * POST { action: 'generate', topic? }       write one list now (a draft unless auto-publish is on)
 * POST { action: 'publish'|'unpublish'|'reject'|'delete', slug }
 * POST { action: 'queue'|'unqueue', topic }
 * POST { action: 'settings', enabled?, auto_publish?, every_days? }
 * POST { action: 'edit', slug, pick?, note?, remove?, title?, h1?, description?, intro? }
 *
 * utils/reading-list-agent does the work. Not on the staff allow-list, so
 * customer-care logins get 403.
 */

const { requireAdmin } = require('./utils/admin-auth');
const agent = require('./utils/reading-list-agent');
const { agentDeps } = require('./utils/reading-list-deps');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: { ...CORS, 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

function view(doc) {
  const queued = doc.topics.queued.map((q) => (typeof q === 'string' ? q : q.topic));
  const next = agent.nextTopic(doc, {});
  return {
    lists: doc.lists.slice().reverse(),
    settings: doc.settings,
    queued,
    next_topic: next ? next.topic : null,
    seeds_left: agent.SEED_TOPICS.filter((t) => !doc.topics.done.map((d) => d.toLowerCase()).includes(t.toLowerCase())).length,
    last_run: doc.last_run,
    counts: ['draft', 'published', 'rejected'].reduce((o, s) => ({ ...o, [s]: doc.lists.filter((l) => l.status === s).length }), {}),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const blocked = requireAdmin(event, CORS); if (blocked) return blocked;
  try {
    if (event.httpMethod === 'GET') return json(200, view(await agent.readDoc()));
    if (event.httpMethod !== 'POST') return json(405, { error: 'GET or POST' });
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const action = String(body.action || '');
    if (action === 'generate') {
      const result = await agent.generateOne({ topic: body.topic, trigger: 'admin' }, await agentDeps());
      const doc = await agent.readDoc();
      return json(result.ok ? 200 : 422, { ...view(doc), result: { ok: result.ok, error: result.error || null, slug: result.slug || null, status: result.status || null, picks: result.picks || 0, candidates: result.candidates || 0 } });
    }
    return json(200, view(await agent.applyAction(action, body)));
  } catch (err) {
    console.error('admin-reading-lists:', err && err.message);
    return json(400, { error: err.message || 'Failed' });
  }
};
