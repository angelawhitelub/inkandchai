/**
 * What a model call cost, in millionths of a dollar.
 *
 * Micros, not dollars, because the numbers involved are tiny -- a typical Ink
 * AI reply is about 7,800 micros, i.e. 0.0078 of a dollar -- and accumulating
 * thousands of those as floats would drift. Integers do not.
 *
 * Prices are per million tokens, from OpenAI's pricing page. They change; when
 * they do, the only correct move is to edit this table, because everything
 * downstream trusts it.
 */

/** USD per 1M tokens: [input, output]. */
const PRICES = {
  'gpt-4o':       [2.50, 10.00],
  'gpt-4o-mini':  [0.15,  0.60],
  'gpt-4.1':      [2.00,  8.00],
  'gpt-4.1-mini': [0.40,  1.60],
};

/**
 * An unknown model bills at the most expensive rate we know rather than at
 * zero. Guessing low on a model nobody has priced would quietly disable the
 * ceiling, which is the failure this whole file exists to prevent.
 */
const FALLBACK = [2.50, 10.00];

function rates(model) {
  const key = String(model || '').trim();
  if (PRICES[key]) return PRICES[key];
  // Dated snapshots ("gpt-4o-2024-08-06") bill as their base model.
  const base = Object.keys(PRICES).filter((k) => key.startsWith(k + '-'))
    .sort((a, b) => b.length - a.length)[0];
  return base ? PRICES[base] : FALLBACK;
}

/** Cost of one completion, in integer micros. */
function costMicros(model, usage) {
  const [inRate, outRate] = rates(model);
  const pin = Math.max(0, Number(usage?.prompt_tokens) || 0);
  const out = Math.max(0, Number(usage?.completion_tokens) || 0);
  return Math.round(pin * inRate + out * outRate);
}

/**
 * The billing month, UTC, because that is the month OpenAI's own invoice uses.
 * Using Asia/Kolkata here would roll the budget over 5.5 hours early and make
 * our total disagree with theirs on the first and last day of every month.
 */
function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

/** A budget in dollars as micros. Anything unparseable means "not set". */
function budgetMicros(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1e6);
}

module.exports = { costMicros, monthKey, budgetMicros, PRICES };
