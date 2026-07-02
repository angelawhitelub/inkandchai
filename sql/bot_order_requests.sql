-- Run once in Supabase SQL editor
create table if not exists bot_order_requests (
  id uuid primary key default gen_random_uuid(),
  customer_phone text,
  customer_name  text,
  address        text,
  books          text,
  notes          text,
  status         text default 'new',   -- new | contacted | ordered | closed
  created_at     timestamptz default now()
);
create index if not exists bot_order_requests_status_idx on bot_order_requests(status);
create index if not exists bot_order_requests_created_idx on bot_order_requests(created_at desc);
