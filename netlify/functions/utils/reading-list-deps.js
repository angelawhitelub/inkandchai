'use strict';
// What the reading-list agent needs from the rest of the store, in one place,
// for the admin endpoint and the scheduled job.
const { createClient } = require('@supabase/supabase-js');
const { booksFor } = require('../reading-list');
const { readLifetimeSales } = require('./lifetime-sales');

async function bestsellerTitles() {
  try {
    const doc = await readLifetimeSales();
    const b = doc && doc.bsr;
    return ((b && b.order) || []).slice(0, 80).map((s) => b.info && b.info[s] && b.info[s].title).filter(Boolean);
  } catch { return []; }
}

async function agentDeps() {
  const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY) : null;
  return {
    supabase,
    priceBooks: (slugs) => booksFor(slugs, supabase),
    bestsellerTitles: await bestsellerTitles(),
  };
}

module.exports = { agentDeps };
