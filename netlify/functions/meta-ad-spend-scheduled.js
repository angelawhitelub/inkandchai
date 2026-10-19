/**
 * Scheduled: meta-ad-spend-scheduled (hourly, jobs.toml)
 *
 * Pulls daily spend for each Meta ad account in META_AD_ACCOUNT_IDS from the
 * Marketing API into ad_spend_daily, for the admin Net Profit tab. The last 7
 * days are re-read every run because Meta revises recent days; the first run
 * (no Meta rows yet) backfills 90.
 *
 * Read-only on Meta. The token needs ads_read and nothing else -- see
 * META_ADS_TOKEN in the setup notes on the Net Profit tab.
 *
 * Env: META_ADS_TOKEN, META_AD_ACCOUNT_IDS ("123,456" or "act_123").
 */

const { createClient } = require('@supabase/supabase-js');
const S = require('./utils/ad-spend');

const RECENT_DAYS = 7;
const BACKFILL_DAYS = 90;

async function syncMeta({ db, token = process.env.META_ADS_TOKEN, accounts = S.metaAccounts(), fetchImpl = fetch, now = new Date() } = {}) {
  if (!token || !accounts.length) return { ok: false, skipped: 'META_ADS_TOKEN / META_AD_ACCOUNT_IDS not set' };
  let have = false;
  try {
    const { data } = await db.from(S.TABLE).select('day').eq('platform', 'meta').limit(1);
    have = !!(data && data.length);
  } catch { /* first run */ }
  const span = have ? RECENT_DAYS : BACKFILL_DAYS;
  const until = S.istDay(now);
  const since = S.istDay(new Date(now.getTime() - (span - 1) * 86400000));
  const results = [];
  for (const id of accounts) {
    try {
      const raw = await S.metaDailySpend({ token, accountId: id, since, until, fetchImpl });
      if (!raw.length) { results.push({ account: id, saved: 0 }); continue; }
      const norm = S.normalizeRows('meta', id, raw, now);
      if (norm.error) throw new Error(norm.error);
      results.push({ account: id, saved: await S.upsertRows(db, norm.rows) });
    } catch (e) {
      results.push({ account: id, error: e.message });
    }
  }
  return { ok: results.every((r) => !r.error), since, until, results };
}

exports.syncMeta = syncMeta;

exports.handler = async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return { statusCode: 500, body: 'Supabase not configured' };
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const out = await syncMeta({ db });
  if (!out.ok) console.warn('[meta-ad-spend]', JSON.stringify(out));
  return { statusCode: 200, body: JSON.stringify(out) };
};
