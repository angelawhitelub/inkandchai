/**
 * Scheduled: reading-list agent (utils/reading-list-agent). Runs nightly with the
 * 22:00 UTC trigger and writes one new list when the last one is `every_days`
 * old (default 3) and the agent is switched on in admin. A draft for review,
 * unless the owner turned auto-publish on. No messages, no product changes.
 * The admin "Generate now" button is admin-reading-lists, not this.
 */

const agent = require('./utils/reading-list-agent');
const { agentDeps } = require('./utils/reading-list-deps');

exports.handler = async () => {
  try {
    const doc = await agent.readDoc();
    if (!agent.isDue(doc)) {
      return { statusCode: 200, body: JSON.stringify({ skipped: doc.settings.enabled ? 'not due' : 'switched off' }) };
    }
    const result = await agent.generateOne({ trigger: 'schedule' }, await agentDeps());
    console.log('[reading-list-agent]', result.ok ? `wrote ${result.slug} (${result.status})` : `failed: ${result.error}`);
    return { statusCode: 200, body: JSON.stringify({ ok: result.ok, slug: result.slug || null, error: result.error || null }) };
  } catch (err) {
    console.error('[reading-list-agent]', err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
