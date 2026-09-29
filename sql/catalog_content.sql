-- Admin-written copy and book details for catalogue books (utils/catalog-content.js).
-- Safe to run more than once.
create table if not exists public.catalog_content (
  slug             text primary key,
  description      text,
  author_bio       text,
  seo_title        text,
  meta_description text,
  tags             text,
  updated_at       timestamptz not null default now()
);
alter table public.catalog_content
  add column if not exists publisher    text,
  add column if not exists isbn         text,
  add column if not exists format       text,
  add column if not exists language     text,
  add column if not exists pages        integer,
  add column if not exists dimensions   text,
  add column if not exists weight_grams integer,
  add column if not exists edition      text,
  add column if not exists published_on text,
  add column if not exists reading_age  text;
alter table public.catalog_content enable row level security;
