const test = require('node:test');
const assert = require('node:assert/strict');
const { costMicros, monthKey, budgetMicros } = require('./ink-ai-budget');

test('a typical reply costs what OpenAI charges for it', () => {
  // 2,500 prompt tokens at $2.50/1M + 150 completion at $10/1M.
  assert.equal(costMicros('gpt-4o', { prompt_tokens: 2500, completion_tokens: 150 }), 7750);
  assert.equal(costMicros('gpt-4o-mini', { prompt_tokens: 2500, completion_tokens: 150 }), 465);
});

test('output tokens are billed at four times input, not the same rate', () => {
  // The bug this guards: averaging the two rates, which undercounts any reply
  // that is long -- exactly the expensive ones.
  const inOnly = costMicros('gpt-4o', { prompt_tokens: 1000, completion_tokens: 0 });
  const outOnly = costMicros('gpt-4o', { prompt_tokens: 0, completion_tokens: 1000 });
  assert.equal(inOnly, 2500);
  assert.equal(outOnly, 10000);
});

test('a dated model snapshot bills as its base model', () => {
  // OpenAI pins deploys as gpt-4o-2024-08-06; that is not a different product.
  assert.equal(
    costMicros('gpt-4o-2024-08-06', { prompt_tokens: 1000, completion_tokens: 100 }),
    costMicros('gpt-4o', { prompt_tokens: 1000, completion_tokens: 100 }),
  );
  assert.equal(
    costMicros('gpt-4o-mini-2024-07-18', { prompt_tokens: 1000, completion_tokens: 100 }),
    costMicros('gpt-4o-mini', { prompt_tokens: 1000, completion_tokens: 100 }),
  );
});

test('an unpriced model bills high, never at zero', () => {
  // Guessing low on an unknown model would silently disable the ceiling.
  const unknown = costMicros('gpt-6-turbo-ultra', { prompt_tokens: 1000, completion_tokens: 100 });
  assert.equal(unknown, costMicros('gpt-4o', { prompt_tokens: 1000, completion_tokens: 100 }));
  assert.ok(unknown > 0);
});

test('missing or malformed usage costs nothing rather than throwing', () => {
  // A completion with no usage block must not take the request down with it.
  assert.equal(costMicros('gpt-4o', undefined), 0);
  assert.equal(costMicros('gpt-4o', {}), 0);
  assert.equal(costMicros('gpt-4o', { prompt_tokens: -5, completion_tokens: 'x' }), 0);
});

test('the billing month is UTC, matching the invoice', () => {
  // 23:00 on the 30th in London is still September; in Kolkata it is October.
  // Rolling over early would put spend in a month OpenAI bills differently.
  assert.equal(monthKey(new Date('2026-09-30T23:00:00Z')), '2026-09');
  assert.equal(monthKey(new Date('2026-10-01T00:00:00Z')), '2026-10');
  assert.match(monthKey(), /^\d{4}-\d{2}$/);
});

test('an unset budget reads as zero, which means no ceiling', () => {
  // Distinct from a ceiling of nothing: 0 must let the bot run, not lock it out.
  assert.equal(budgetMicros(25), 25_000_000);
  assert.equal(budgetMicros('25'), 25_000_000);
  assert.equal(budgetMicros('2.50'), 2_500_000);
  assert.equal(budgetMicros(undefined), 0);
  assert.equal(budgetMicros(''), 0);
  assert.equal(budgetMicros('abc'), 0);
  assert.equal(budgetMicros(-5), 0);
});
