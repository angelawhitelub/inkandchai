-- Bestseller agent review queue.
-- Written by: netlify/functions/bestseller-agent-scheduled.js (utils/bestseller-agent.js)
-- Read/decided by: netlify/functions/bestseller-candidates.js (admin "Bestsellers" tab)
--
-- One row per Amazon ASIN the agent has ever looked at, whatever it decided,
-- so a title is fetched once and never re-suggested after a reject.
--   status: pending | approved | rejected | skipped | in_catalogue
-- Functions use the service key, which bypasses RLS; RLS is enabled with no
-- policies so the anon key cannot read or write this table.

create table if not exists public.bestseller_candidates (
  id                  uuid primary key default gen_random_uuid(),
  asin                text unique not null,
  isbn13              text,
  title               text not null,
  amazon_title        text,
  author              text,
  publisher           text,
  language            text,
  format              text,
  pages               integer,
  published_on        text,
  weight_grams        integer,
  dimensions          text,
  reading_age         text,
  category            text,
  source_list         text,
  best_rank           integer,
  lists               jsonb default '[]'::jsonb,
  mrp_inr             numeric,
  mrp_source          text,
  crossword_mrp_inr   numeric,
  amazon_price_inr    numeric,
  price_inr           numeric,
  image_url           text,
  image_source        text,
  description         text,
  author_bio          text,
  tags                text,
  seo_title           text,
  meta_description    text,
  possible_duplicate  jsonb,
  warnings            jsonb default '[]'::jsonb,
  status              text not null default 'pending',
  status_reason       text,
  product_slug        text,
  times_seen          integer default 1,
  first_seen_at       timestamptz default now(),
  last_seen_at        timestamptz default now(),
  decided_at          timestamptz,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

create index if not exists bestseller_candidates_status_rank_idx on public.bestseller_candidates (status, best_rank);
create index if not exists bestseller_candidates_isbn13_idx on public.bestseller_candidates (isbn13);
alter table public.bestseller_candidates enable row level security;

create table if not exists public.bestseller_agent_runs (
  id          bigserial primary key,
  trigger     text,
  started_at  timestamptz default now(),
  finished_at timestamptz,
  summary     jsonb
);
alter table public.bestseller_agent_runs enable row level security;
