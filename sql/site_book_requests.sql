-- Books customers asked for from the website search when they could not find
-- them (search dropdown → "Request this book"). Admin → 📥 Book Requests.
-- Written only by netlify/functions/site-book-request.js (service key).
create table if not exists public.site_book_requests (
  id             bigserial primary key,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  title          text not null,
  title_key      text not null,
  author         text,
  customer_name  text,
  phone          text,
  email          text,
  contact_key    text not null,
  note           text,
  search_query   text,
  source         text,
  page_url       text,
  request_count  integer not null default 1,
  status         text not null default 'new'
                 check (status in ('new', 'sourcing', 'added', 'unavailable', 'closed')),
  admin_note     text
);
-- One row per customer per book; asking again bumps request_count.
create unique index if not exists site_book_requests_contact_title_uidx
  on public.site_book_requests (contact_key, title_key);
create index if not exists site_book_requests_created_idx on public.site_book_requests (created_at desc);
create index if not exists site_book_requests_status_idx on public.site_book_requests (status);
create index if not exists site_book_requests_title_idx on public.site_book_requests (title_key);
alter table public.site_book_requests enable row level security;
