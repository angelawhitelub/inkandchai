/**
 * Netlify Function: bot-model-eval
 * Headers: X-Admin-Key / X-Admin-Token
 *
 * GET                            -> { model, candidate }   what the bot runs on now
 * POST { model, apply }          -> runs the safety cases against `model`;
 *                                   with apply=true AND every case passing, the
 *                                   WhatsApp bot switches to it within a minute
 * POST { model, revert: true }   -> switch back to `model` (e.g. gpt-4o) at once,
 *                                   no test -- the way out if anything looks off
 *
 * The cases (utils/bot-model.js BOT_EVAL_CASES) are sent with the bot's real
 * system prompt, its live FAQ instructions and its real tools. The model's
 * FIRST response is inspected -- which tool it would call, with what
 * arguments -- and nothing is executed: no order is cancelled, no replacement
 * filed, no message sent. Cost: one short request per case.
 */

const { requireAdmin } = require('./utils/admin-auth');
const { BOT_EVAL_CASES, judgeCase, currentBotModel, setBotModel, CANDIDATE_MODEL, FALLBACK_MODEL } = require('./utils/bot-model');
const bot = require('./whatsapp-bot')._internal;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Token',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const MODEL_RE = /^(gpt-[0-9][a-z0-9.\-]*|o[0-9][a-z0-9.\-]*)$/i;

async function runCase(testCase, model, extraInstructions) {
  const context = testCase.order ? bot.formatOrderContext(testCase.order) : '';
  const messages = [{ role: 'system', content: bot.buildSystemContent(extraInstructions, null, context) }, ...testCase.turns];
  try {
    // noFallback: a failing candidate must fail the test, not quietly be
    // answered by gpt-4o and pass.
    const message = await bot.callOpenAIChat(messages, { tools: true, model, noFallback: true });
    const verdict = judgeCase(testCase, message);
    return { id: testCase.id, why: testCase.why, ...verdict, reply: String(message.content || '').slice(0, 400) };
  } catch (e) {
    return { id: testCase.id, why: testCase.why, pass: false, problems: [e.message], tools: [], reply: '' };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS); if (block) return block;

  if (event.httpMethod === 'GET') {
    return json(200, { model: await currentBotModel(), candidate: CANDIDATE_MODEL, fallback: FALLBACK_MODEL });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const model = String(body.model || CANDIDATE_MODEL).trim();
  if (!MODEL_RE.test(model)) return json(400, { error: 'That does not look like an OpenAI model name.' });

  if (body.revert) {
    await setBotModel(model, { reason: 'reverted from admin' });
    return json(200, { success: true, model, applied: true });
  }
  if (!process.env.OPENAI_API_KEY) return json(503, { error: 'OPENAI_API_KEY is not readable on this deploy.' });

  const extra = await bot.getBotExtraInstructions();
  const results = [];
  // Three at a time: quick, and well inside the account's rate limits.
  for (let i = 0; i < BOT_EVAL_CASES.length; i += 3) {
    results.push(...await Promise.all(BOT_EVAL_CASES.slice(i, i + 3).map((c) => runCase(c, model, extra))));
  }
  const passed = results.filter((r) => r.pass).length;
  const allPass = passed === results.length;

  let applied = false;
  if (body.apply && allPass) {
    await setBotModel(model, { reason: `passed ${passed}/${results.length} safety cases` });
    applied = true;
  }
  return json(200, {
    success: true, model, passed, total: results.length, all_pass: allPass, applied,
    live_model: await currentBotModel(), results,
  });
};
