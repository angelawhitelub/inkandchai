-- Run once in Supabase SQL editor.
-- Free delivery for individual books (catalogue or admin-created), set from the
-- admin product editor. A row means that book ships free, and so does any
-- order that contains it (utils/free-delivery.js).
create table if not exists product_free_delivery (
  slug        text primary key,
  updated_at  timestamptz not null default now()
);

alter table product_free_delivery enable row level security;

-- Only the service-role functions read or write it.
revoke all on table product_free_delivery from anon, authenticated;
