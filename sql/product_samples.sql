-- Run once in Supabase SQL editor.
-- "Read sample" PDFs for physical books, uploaded from the admin product editor.
-- One row per product slug; the PDF itself lives in R2 under samples/.
create table if not exists product_samples (
  slug       text primary key,
  r2_key     text not null,
  pages      smallint not null check (pages between 1 and 60),
  size_bytes integer,
  updated_at timestamptz not null default now()
);

alter table product_samples enable row level security;

-- Only the service-role functions read or write it.
revoke all on table product_samples from anon, authenticated;
