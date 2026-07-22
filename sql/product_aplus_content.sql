-- Run once in Supabase SQL editor.
-- Per-product A+ modules used by both static catalogue pages and custom pages.
create table if not exists product_aplus_content (
  slug text primary key,
  heading text,
  intro text,
  blocks jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);

create index if not exists product_aplus_content_active_idx
  on product_aplus_content (is_active, updated_at desc);

alter table product_aplus_content enable row level security;

-- The browser never talks to this table directly. Netlify functions use the
-- service-role key, and the public read endpoint returns only sanitised fields.
revoke all on table product_aplus_content from anon, authenticated;
