-- Admin-created product listings (no-deploy products).
-- Used by: create-product-listing.js (insert/upsert), get-product-overrides.js
-- (catalogue/search merge), product-page.js (dynamic product page render).
-- Prices are stored as text ("399.00") to match ALL_BOOKS.json formatting; the
-- client priceToText() parses them. Functions use the service key, which bypasses
-- RLS, so no policies are required.

create table if not exists public.custom_products (
  id                 uuid primary key default gen_random_uuid(),
  slug               text unique not null,
  title              text not null,
  author             text,
  category           text,
  description        text,
  price_inr          text,
  original_price_inr text,
  image_url          text,
  publisher          text,
  isbn               text,
  seo_title          text,
  meta_description   text,
  tags               text,
  is_active          boolean default true,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

-- Fast lookups by slug (product page) and active filter (catalogue/search).
create index if not exists custom_products_slug_idx   on public.custom_products (slug);
create index if not exists custom_products_active_idx on public.custom_products (is_active);
