-- Title scout (26 Nov 2026): where each draft came from, the demand behind it,
-- and its score, for the admin 📈 Bestsellers review queue. Also the Meta ad
-- drafts the agent builds for approved books (always created PAUSED).
-- Safe to run more than once.

alter table public.bestseller_candidates
  add column if not exists source        text,     -- amazon_bestseller | amazon_new_release | customer_request | author_followup
  add column if not exists demand        jsonb,    -- { customers, requests, sources, asked_as, last_at }
  add column if not exists score         integer,  -- 0-100, utils/title-scout scoreCandidate
  add column if not exists score_reasons jsonb default '[]'::jsonb,
  add column if not exists scored_at     timestamptz;

update public.bestseller_candidates set source = 'amazon_bestseller' where source is null;

create index if not exists bestseller_candidates_status_score_idx
  on public.bestseller_candidates (status, score desc nulls last);

create table if not exists public.meta_ad_drafts (
  id            bigserial primary key,
  slug          text not null,
  candidate_id  uuid,
  title         text,
  ad_account_id text,
  campaign_id   text,
  adset_id      text,
  creative_id   text,
  ad_id         text,
  image_hash    text,
  headline      text,
  primary_text  text,
  description   text,
  link          text,
  daily_budget_inr numeric,
  status        text not null default 'paused',   -- paused | failed
  error         text,
  created_at    timestamptz default now()
);
create index if not exists meta_ad_drafts_slug_idx on public.meta_ad_drafts (slug);
alter table public.meta_ad_drafts enable row level security;
