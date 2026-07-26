-- Cover + gallery image overrides for catalogue products.
-- Safe to run repeatedly.
alter table product_overrides
  add column if not exists gallery_images jsonb default '[]'::jsonb;
