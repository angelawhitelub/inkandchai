-- Photos and a video on product reviews (admin "Add a Review" form, 13 Nov 2026).
-- Public https URLs in the R2 image bucket: reviews/<slug>/ and videos/.
-- Safe to run more than once.
alter table public.product_reviews
  add column if not exists photos jsonb not null default '[]'::jsonb,
  add column if not exists video_url text,
  add column if not exists video_poster text;
