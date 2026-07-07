-- Customer memory for the WhatsApp bot — so repeat customers don't have to
-- re-share their name/address every time they place a new order.
--
-- The bot upserts here when submit_order_request succeeds, and reads from
-- here at the start of each order flow to pre-fill known fields.
create table if not exists bot_customers (
  customer_phone text primary key,           -- 10-digit last-10
  customer_name  text,
  address        text,
  last_order_id  text,
  order_count    integer default 0,
  updated_at     timestamptz default now(),
  created_at     timestamptz default now()
);

create index if not exists bot_customers_updated_idx
  on bot_customers(updated_at desc);
