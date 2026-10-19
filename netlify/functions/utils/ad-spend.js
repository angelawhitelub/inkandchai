'use strict';

/**
 * Real daily ad spend (Google Ads + Meta) for the Net Profit tab.
 *
 * Both platforms report spend per calendar day in the ad account's time zone,
 * which for these accounts is IST, so a `day` here lines up with an IST order
 * day. Rows are upserted on (day, platform, account): a platform revising a
 * day's figure (late clicks, invalid-click credits) simply overwrites it.
 *
 * Every read tolerates the table not existing yet: the profit tab then falls
 * back to the owner's per-order average, exactly as before.
 */

const TABLE = 'ad_spend_daily';
const PLATFORMS = ['google', 'meta'];
const IST_MS = 330 * 60 * 1000;
const MAX_ROWS = 400;

/** YYYY-MM-DD of the IST calendar day containing `date`. */
function istDay(date = new Date()) {
  return new Date(new Date(date).getTime() + IST_MS).toISOString().slice(0, 10);
}

/** The UTC instant at which IST day `day` (YYYY-MM-DD) starts. */
function istDayStart(day) {
  return new Date(Date.parse(day + 'T00:00:00Z') - IST_MS);
}

function cleanAccount(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
}

const nonNeg = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Raw platform rows → table rows, or { error }. `date` may come as YYYY-MM-DD
 * or YYYYMMDD; `cost` is in rupees.
 */
function normalizeRows(platform, account, rows, now = new Date()) {
  if (!PLATFORMS.includes(platform)) return { error: `Unknown platform "${platform}"` };
  const acct = cleanAccount(account);
  if (!acct) return { error: 'Missing account' };
  if (!Array.isArray(rows) || !rows.length) return { error: 'No rows' };
  if (rows.length > MAX_ROWS) return { error: `At most ${MAX_ROWS} rows per post` };
  const tomorrow = istDay(new Date(now.getTime() + 86400000));
  const out = [];
  for (const r of rows) {
    const raw = String((r && (r.date || r.day)) || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw + 'T00:00:00Z')) || raw > tomorrow) {
      return { error: `Bad date "${r && (r.date || r.day)}"` };
    }
    const spend = nonNeg(r.cost ?? r.spend);
    if (spend === null) return { error: `Bad cost on ${raw}` };
    const int = (v) => { const n = nonNeg(v); return n === null ? null : Math.round(n); };
    out.push({
      day: raw,
      platform,
      account: acct,
      spend_inr: Math.round(spend * 100) / 100,
      clicks: int(r.clicks),
      impressions: int(r.impressions),
      conversions: nonNeg(r.conversions),
      updated_at: now.toISOString(),
    });
  }
  return { rows: out };
}

function isMissingTable(error) {
  const msg = String((error && error.message) || '');
  const code = String((error && error.code) || '');
  return code === '42P01' || (/ad_spend_daily/.test(msg) && /(does not exist|schema cache|not find)/i.test(msg));
}

/**
 * Spend between two IST days inclusive → { available, byDay: { day: {google, meta, total} },
 * total: {google, meta, total}, firstDay, lastDay, accounts }.
 */
async function fetchSpend(supabase, fromDay, toDay) {
  const empty = { available: false, byDay: {}, total: { google: 0, meta: 0, total: 0 }, firstDay: null, lastDay: null, accounts: [] };
  if (!supabase) return empty;
  try {
    let q = supabase.from(TABLE).select('day,platform,account,spend_inr').order('day', { ascending: true }).limit(5000);
    if (fromDay) q = q.gte('day', fromDay);
    if (toDay) q = q.lte('day', toDay);
    const { data, error } = await q;
    if (error) {
      if (!isMissingTable(error)) console.warn('[ad-spend] read:', error.message);
      return { ...empty, missing: isMissingTable(error) };
    }
    const byDay = {};
    const total = { google: 0, meta: 0, total: 0 };
    const accounts = new Set();
    for (const r of data || []) {
      const d = String(r.day).slice(0, 10);
      const v = Number(r.spend_inr) || 0;
      const slot = byDay[d] || (byDay[d] = { google: 0, meta: 0, total: 0 });
      slot[r.platform] = (slot[r.platform] || 0) + v;
      slot.total += v;
      total[r.platform] = (total[r.platform] || 0) + v;
      total.total += v;
      accounts.add(`${r.platform}:${r.account}`);
    }
    const days = Object.keys(byDay).sort();
    return { available: days.length > 0, byDay, total, firstDay: days[0] || null, lastDay: days[days.length - 1] || null, accounts: [...accounts].sort() };
  } catch (e) {
    console.warn('[ad-spend] read threw:', e.message);
    return empty;
  }
}

/** First spend day ever recorded per platform, so a range can say whether it is fully covered. */
async function coverage(supabase) {
  const out = {};
  if (!supabase) return out;
  for (const p of PLATFORMS) {
    try {
      const { data, error } = await supabase.from(TABLE).select('day').eq('platform', p).order('day', { ascending: true }).limit(1);
      if (!error && data && data[0]) out[p] = String(data[0].day).slice(0, 10);
    } catch { /* tolerated */ }
  }
  return out;
}

async function upsertRows(supabase, rows) {
  const { error } = await supabase.from(TABLE).upsert(rows, { onConflict: 'day,platform,account' });
  if (error) throw Object.assign(new Error(error.message), { missingTable: isMissingTable(error) });
  return rows.length;
}

// ── Meta Marketing API ──────────────────────────────────────────────────────
const META_API = 'https://graph.facebook.com/v21.0';

function metaAccounts(raw = process.env.META_AD_ACCOUNT_IDS) {
  return String(raw || '').split(/[\s,]+/).map((s) => s.replace(/^act_/, '').replace(/\D/g, '')).filter(Boolean);
}

/** Daily spend rows for one ad account over [since, until] (IST days, inclusive). */
async function metaDailySpend({ token, accountId, since, until, fetchImpl = fetch }) {
  const params = new URLSearchParams({
    level: 'account',
    time_increment: '1',
    time_range: JSON.stringify({ since, until }),
    fields: 'spend,impressions,clicks,account_currency',
    limit: '100',
  });
  let url = `${META_API}/act_${accountId}/insights?${params}`;
  const rows = [];
  for (let page = 0; url && page < 20; page += 1) {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      const e = body.error || {};
      throw new Error(`Meta act_${accountId}: ${e.message || 'HTTP ' + res.status}${e.code ? ' (code ' + e.code + ')' : ''}`);
    }
    for (const d of body.data || []) {
      if (d.account_currency && d.account_currency !== 'INR') {
        throw new Error(`Meta act_${accountId} bills in ${d.account_currency}, not INR`);
      }
      rows.push({ date: d.date_start, cost: d.spend, clicks: d.clicks, impressions: d.impressions });
    }
    url = body.paging && body.paging.next;
  }
  return rows;
}

module.exports = {
  TABLE, PLATFORMS, MAX_ROWS, istDay, istDayStart, cleanAccount, normalizeRows, isMissingTable,
  fetchSpend, coverage, upsertRows, metaAccounts, metaDailySpend,
};
