/**
 * What customers actually asked Ink AI.
 *
 * GET /.netlify/functions/ink-ai-questions?limit=60&only=escalated
 *   → { questions: [...], counts: { total, escalated }, table_missing? }
 *
 * The review half of the learning loop. The bot's knowledge is edited in
 * Admin → Bot Instructions, which writes bot_settings.extra_instructions and is
 * injected as authoritative on the next message — but nobody can write a good
 * answer to a question they never saw asked. This lists them, escalated first,
 * so the gaps are the first thing on screen.
 *
 * Read-only and admin-gated: the rows are customer-typed text.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');
const { TABLE } = require('./ink-ai');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body, null, 2),
});

// Postgres says 42P01 when a relation does not exist. Until the migration is
// run that is the expected answer, not a fault, so it gets its own reply rather
// than a 500 the admin panel would render as a red error.
const MISSING_TABLE = /relation .* does not exist/i;

exports.handler = async (event) => {
  const block = requireAdmin(event);
  if (block) return block;

  const q = event.queryStringParameters || {};
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 60, 1), 200);
  const onlyEscalated = q.only === 'escalated';

  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    let query = db.from(TABLE)
      .select('id, created_at, question, answer, escalated, page_url, turn')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (onlyEscalated) query = query.eq('escalated', true);

    const { data, error } = await query;
    if (error) {
      if (MISSING_TABLE.test(error.message)) {
        return json(200, { questions: [], counts: null, table_missing: true });
      }
      throw new Error(error.message);
    }

    const [{ count: total }, { count: escalated }] = await Promise.all([
      db.from(TABLE).select('id', { count: 'exact', head: true }),
      db.from(TABLE).select('id', { count: 'exact', head: true }).eq('escalated', true),
    ]);

    return json(200, {
      questions: data || [],
      counts: { total: total ?? null, escalated: escalated ?? null },
    });
  } catch (err) {
    console.error('[ink-ai-questions]', err.message);
    return json(500, { error: err.message });
  }
};
