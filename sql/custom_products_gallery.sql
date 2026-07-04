-- Run once in Supabase SQL editor: extra product images (back cover, spreads…)
alter table custom_products add column if not exists gallery_images jsonb default '[]'::jsonb;
