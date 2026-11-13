-- Photos on product reviews (admin "Add a Review" form, 13 Nov 2026).
-- Public https URLs in the R2 image bucket, under reviews/<slug>/.
alter table public.product_reviews
  add column if not exists photos jsonb not null default '[]'::jsonb;
