-- Admin-written copy for catalogue books (utils/catalog-content.js).
create table if not exists public.catalog_content (
  slug             text primary key,
  description      text,
  author_bio       text,
  seo_title        text,
  meta_description text,
  tags             text,
  updated_at       timestamptz not null default now()
);
alter table public.catalog_content enable row level security;
