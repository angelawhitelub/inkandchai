-- Stores import-run summaries so their outcome is inspectable with SQL.
-- Netlify does not surface logs for background functions, so the scraper writes
-- its result (fetched/inserted/skipped/fetch_error) here instead.
create table if not exists import_runs (
  id         uuid primary key default gen_random_uuid(),
  source     text,
  summary    jsonb,
  created_at timestamptz default now()
);

create index if not exists import_runs_created_idx on import_runs(created_at desc);

-- Inspect the latest run:
--   select source, summary, created_at from import_runs order by created_at desc limit 1;
