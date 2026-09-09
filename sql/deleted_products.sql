-- Product pages taken down for good.
--
-- Catalogue books are baked static files with no database row, so "deleted"
-- cannot be a row deletion. This table IS the deletion: netlify/functions/
-- delete-product.js writes it, mirrors the slugs to Workers KV, and
-- worker/index.js answers 410 Gone for those URLs before the asset router runs.
-- generate_site.py reads the same list (data/deleted_products.json) so the next
-- regeneration stops emitting the page, the sitemap entry and the feed entry.
--
-- 410, not 404: 404 means "might come back" and Google re-crawls it for months.
-- For a temporary stock-out use Remove From Sale instead — that keeps the page.
create table if not exists public.deleted_products (
  slug        text primary key,
  title       text,
  -- 'catalogue' = baked static page (reversible: the file is still there).
  -- 'custom'    = custom_products row, already deleted (not reversible).
  kind        text not null default 'catalogue',
  reason      text,
  deleted_at  timestamptz not null default now(),
  deleted_by  text
);

create index if not exists deleted_products_deleted_at_idx
  on public.deleted_products (deleted_at desc);

-- Service-role only. The storefront never reads this table directly; the slugs
-- reach the browser through get-product-overrides, which runs service-side.
alter table public.deleted_products enable row level security;
