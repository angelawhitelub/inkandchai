#!/usr/bin/env node
/**
 * Build the "frequently bought together" signal file from real orders.
 *
 * Runs at deploy time (see netlify.toml) and writes data/fbt-signals.json,
 * which netlify/functions/frequently-bought.js reads off disk the same way it
 * reads ALL_BOOKS.json. No Supabase call on the request path.
 *
 * Two signals come out of it:
 *
 *   pairs        how often two books were bought in the SAME order. This is the
 *                only recommender input here that is not a guess, and it finds
 *                what content similarity cannot: System Design Vol 1 and Vol 2
 *                were bought together 118 times, and Musafir Cafe (Hindi) sells
 *                with The Forty Rules of Love (English) -- different language,
 *                different genre, same reader.
 *
 *   bestsellers  units actually sold per book, so the fallback for the long tail
 *                is "the book in this category people actually buy" rather than
 *                "a book whose title happens to share a word".
 *
 * Cancelled, RTO and refunded orders are excluded: a book that gets ordered and
 * sent back is not a book to push. Replacements are excluded too -- those are
 * our own re-shipments, not demand, and would double-count whatever goes wrong
 * most often.
 *
 * Never fails the build. If Supabase is unreachable the site still deploys and
 * frequently-bought falls back to similarity scoring, exactly as before.
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(process.cwd(), 'data', 'fbt-signals.json');

// Statuses that represent a real, kept sale. cancelled / rto / refunded and the
// refund-pipeline states are deliberately absent.
const KEPT = new Set([
  'delivered', 'shipped', 'out_for_delivery', 'paid',
  'cod_pending', 'partial_cod_pending', 'confirmed',
]);

// A basket this large is a bulk order, not a reading list. Left in, its pairs
// would swamp everything else: one 20-book order alone creates 190 pairs.
const MAX_BASKET_FOR_PAIRS = 6;

// One co-purchase is noise. Two separate customers buying the same two books is
// the smallest thing worth calling a pattern.
const MIN_PAIR = 2;

function slugOf(item) {
  const raw = String((item && (item.url || item.id || item.slug)) || '');
  const m = raw.match(/\/product\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : '';
}

function isReplacement(order) {
  return String(order.source || '').toLowerCase() === 'replacement'
    || /^IC-R-/i.test(String(order.razorpay_order_id || ''));
}

function empty(reason) {
  return {
    generated_at: new Date().toISOString(),
    reason, orders: 0, baskets: 0, bestsellers: [], pairs: {},
  };
}

async function build() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return empty('supabase env not configured');

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(url, key);

  // A year, capped. Older baskets describe a catalogue we largely no longer sell.
  const since = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
  let rows = [];
  for (let from = 0; from < 40000; from += 1000) {
    const { data, error } = await supabase
      .from('orders')
      .select('razorpay_order_id,status,cart_items,created_at,source')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows = rows.concat(data);
    if (data.length < 1000) break;
  }

  const units = new Map();
  const co = new Map();
  let baskets = 0;

  for (const order of rows) {
    if (isReplacement(order)) continue;
    if (!KEPT.has(String(order.status || '').toLowerCase())) continue;

    let cart = order.cart_items;
    if (typeof cart === 'string') { try { cart = JSON.parse(cart); } catch (_) { cart = []; } }
    if (!Array.isArray(cart) || !cart.length) continue;

    for (const item of cart) {
      const s = slugOf(item);
      if (s) units.set(s, (units.get(s) || 0) + (Number(item.qty) || 1));
    }

    const slugs = [...new Set(cart.map(slugOf).filter(Boolean))];
    if (!slugs.length) continue;
    baskets++;
    if (slugs.length < 2 || slugs.length > MAX_BASKET_FOR_PAIRS) continue;

    for (let i = 0; i < slugs.length; i++) {
      for (let j = i + 1; j < slugs.length; j++) {
        const pairKey = [slugs[i], slugs[j]].sort().join(' ');
        co.set(pairKey, (co.get(pairKey) || 0) + 1);
      }
    }
  }

  const pairs = {};
  for (const [pairKey, count] of co) {
    if (count < MIN_PAIR) continue;
    const [a, b] = pairKey.split(' ');
    (pairs[a] = pairs[a] || []).push([b, count]);
    (pairs[b] = pairs[b] || []).push([a, count]);
  }
  // Strongest partners first, capped -- the UI shows a handful at most.
  for (const slug of Object.keys(pairs)) {
    pairs[slug].sort((x, y) => y[1] - x[1]);
    pairs[slug] = pairs[slug].slice(0, 8);
  }

  const bestsellers = [...units.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 400);

  return {
    generated_at: new Date().toISOString(),
    orders: rows.length,
    baskets,
    products_sold: units.size,
    products_with_partners: Object.keys(pairs).length,
    bestsellers,
    pairs,
  };
}

build()
  .then((signals) => {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(signals));
    const kb = Math.round(fs.statSync(OUT).size / 1024);
    console.log('FBT signals: ' + (signals.baskets || 0) + ' baskets, '
      + (signals.bestsellers || []).length + ' bestsellers, '
      + Object.keys(signals.pairs || {}).length + ' products with real partners (' + kb + ' KB)');
  })
  .catch((err) => {
    // Never break a deploy over a recommender.
    console.warn('FBT signals unavailable, falling back to similarity only:', err.message);
    try {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, JSON.stringify(empty(err.message)));
    } catch (_) { /* nothing more we can do */ }
  });
