-- Run once in Supabase SQL editor (fresh install)
create table if not exists bot_order_requests (
  id uuid primary key default gen_random_uuid(),
  order_id        text,                  -- IC-W-YYYYMMDD-XXXXX (assigned by the bot)
  customer_phone  text,
  customer_name   text,
  address         text,
  books           text,
  notes           text,
  status          text default 'new',    -- new | contacted | ordered | closed
  order_pushed_id text,                  -- razorpay_order_id once converted into a real order
  created_at      timestamptz default now()
);
create index if not exists bot_order_requests_status_idx on bot_order_requests(status);
create index if not exists bot_order_requests_created_idx on bot_order_requests(created_at desc);

-- If you ALREADY created the table earlier (without order_id / order_pushed_id),
-- run these two lines (safe to run regardless):
alter table bot_order_requests add column if not exists order_id        text;
alter table bot_order_requests add column if not exists order_pushed_id text;
