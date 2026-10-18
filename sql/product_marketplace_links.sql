-- Run once in Supabase SQL editor.
-- "Also buy on Amazon / Flipkart" links for individual books, set from the
-- admin product editor. One row per product slug; either link may be empty.
create table if not exists product_marketplace_links (
  slug         text primary key,
  amazon_url   text,
  flipkart_url text,
  updated_at   timestamptz not null default now()
);

alter table product_marketplace_links enable row level security;

-- Only the service-role functions read or write it.
revoke all on table product_marketplace_links from anon, authenticated;
