const test = require('node:test');
const assert = require('node:assert/strict');
const { chatPayload, judgeCase, BOT_EVAL_CASES } = require('./bot-model');

const call = (name, args) => ({ tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] });
const byId = (id) => BOT_EVAL_CASES.find((c) => c.id === id);

test('each model family gets the parameters it accepts', () => {
  const four = chatPayload('gpt-4o', { messages: [], maxTokens: 320, temperature: 0.4 });
  assert.equal(four.max_tokens, 320);
  assert.equal(four.temperature, 0.4);
  assert.equal(four.max_completion_tokens, undefined);

  const five1 = chatPayload('gpt-5.1', { messages: [], tools: [{ type: 'function' }] });
  assert.equal(five1.max_completion_tokens, 320);
  assert.equal(five1.reasoning_effort, 'none');
  assert.equal(five1.temperature, undefined);
  assert.equal(five1.max_tokens, undefined);
  assert.equal(five1.tool_choice, 'auto');

  assert.equal(chatPayload('gpt-5-mini', { messages: [] }).reasoning_effort, 'minimal');
  assert.equal(chatPayload('gpt-4.1', { messages: [] }).max_tokens, 320);
});

test('the judge fails an unconfirmed cancel and passes a confirmed one', () => {
  assert.equal(judgeCase(byId('bare-order-id'), call('cancel_order', { order_id: 'IC-20260927-T3ST1' })).pass, false);
  assert.equal(judgeCase(byId('bare-order-id'), { content: 'Here is the status of your order…' }).pass, true);
  assert.equal(judgeCase(byId('cancel-asks-first'), { content: '' }).pass, false);           // silence is not an answer
  assert.equal(judgeCase(byId('cancel-after-yes'), { content: 'Sure' }).pass, false);       // must act once confirmed
  assert.equal(judgeCase(byId('cancel-after-yes'), call('cancel_order', { order_id: 'IC-20260927-T3ST1' })).pass, true);
  assert.equal(judgeCase(byId('cancel-after-yes'), call('cancel_order', { order_id: 'IC-20260101-OTHER' })).pass, false);
  assert.equal(judgeCase(byId('missing-book-after-yes'), call('report_missing_book', { books: [{ title: 'Atomic Habits' }] })).pass, true);
  assert.equal(judgeCase(byId('missing-book-after-yes'),
    call('report_missing_book', { books: [{ title: 'Atomic Habits' }, { title: 'The Psychology of Money' }] })).pass, false);
});

test('the bot sends gpt-5.1 its own parameters and answers on gpt-4o if gpt-5.1 is rejected', async () => {
  const bot = require('../whatsapp-bot')._internal;
  const saved = { fetch: global.fetch, key: process.env.OPENAI_API_KEY };
  const bodies = [];
  process.env.OPENAI_API_KEY = 'test';
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.model === 'gpt-5.1') return { ok: false, status: 400, headers: { get: () => null }, json: async () => ({ error: { message: 'model not available' } }) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) };
  };
  try {
    const msg = await bot.callOpenAIChat([{ role: 'user', content: 'hello' }], { tools: true, model: 'gpt-5.1' });
    assert.equal(msg.content, 'hi');
    assert.equal(bodies[0].model, 'gpt-5.1');
    assert.equal(bodies[0].reasoning_effort, 'none');
    assert.equal(bodies[0].temperature, undefined);
    assert.equal(bodies[1].model, 'gpt-4o');
    assert.equal(bodies[1].temperature, 0.4);
    assert.ok(Array.isArray(bodies[1].tools) && bodies[1].tools.length > 0);

    // The eval asks for noFallback: a rejected candidate must fail, not pass on gpt-4o.
    bodies.length = 0;
    await assert.rejects(bot.callOpenAIChat([{ role: 'user', content: 'x' }], { tools: true, model: 'gpt-5.1', noFallback: true }));
    assert.equal(bodies.length, 1);
  } finally {
    global.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.key;
  }
});

test('the eval prompt is the bot prompt: FAQ first, order context last', () => {
  const bot = require('../whatsapp-bot')._internal;
  const ctx = bot.formatOrderContext(byId('cancel-after-yes').order);
  const s = bot.buildSystemContent('FAQ LINE', null, ctx);
  assert.ok(s.startsWith('⚠️ STORE-SPECIFIC INSTRUCTIONS'));
  assert.ok(s.includes('FAQ LINE'));
  assert.ok(s.endsWith(ctx));
  assert.ok(ctx.includes('IC-20260927-T3ST1') && ctx.includes('Atomic Habits'));
});
