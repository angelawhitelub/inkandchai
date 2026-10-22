-- Run once in Supabase SQL editor.
-- Real daily ad spend, one row per day per ad account, for the admin Net Profit
-- tab. Google Ads rows are posted by a Google Ads script (ad-spend-ingest);
-- Meta rows are pulled hourly from the Marketing API (meta-ad-spend-scheduled).
create table if not exists ad_spend_daily (
  day         date        not null,
  platform    text        not null check (platform in ('google', 'meta')),
  account     text        not null,
  spend_inr   numeric     not null default 0 check (spend_inr >= 0),
  clicks      integer,
  impressions integer,
  conversions numeric,
  updated_at  timestamptz not null default now(),
  primary key (day, platform, account)
);

alter table ad_spend_daily enable row level security;

-- Only the service-role functions read or write it.
revoke all on table ad_spend_daily from anon, authenticated;
