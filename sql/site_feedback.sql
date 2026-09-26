-- Customer feedback on the website and on ordering (admin → 📝 Feedback).
create table if not exists public.site_feedback (
  id             bigserial primary key,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  feedback_key   text not null unique,
  kind           text not null check (kind in ('website', 'order')),
  rating         smallint not null check (rating between 1 and 5),
  comment        text,
  order_id       text,
  order_verified boolean not null default false,
  visitor_id     text,
  page_url       text,
  device         text
);
create index if not exists site_feedback_created_idx on public.site_feedback (created_at desc);
create index if not exists site_feedback_updated_idx on public.site_feedback (updated_at desc);
create index if not exists site_feedback_kind_rating_idx on public.site_feedback (kind, rating);
alter table public.site_feedback enable row level security;

-- The earlier Ink AI chat-rating table is no longer used.
drop table if exists public.ink_ai_feedback;
