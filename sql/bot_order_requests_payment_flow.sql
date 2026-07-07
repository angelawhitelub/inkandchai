-- Adds payment-mode + 5-min confirmation follow-up columns to bot_order_requests.
-- Safe to run multiple times.
alter table bot_order_requests
  add column if not exists payment_mode              text,           -- 'cod' | 'prepaid'
  add column if not exists amount_paise              bigint,         -- copied so payment link can be regenerated
  add column if not exists payment_link              text,           -- Razorpay short_url
  add column if not exists razorpay_payment_link_id  text,           -- plink_...
  add column if not exists payment_status            text,           -- created | paid | expired | cancelled
  add column if not exists paid_at                   timestamptz,
  add column if not exists follow_up_at              timestamptz,    -- when to send the "still on?" ping
  add column if not exists follow_up_sent_at         timestamptz,
  add column if not exists customer_confirmed_at     timestamptz,
  add column if not exists customer_cancelled_at     timestamptz;

create index if not exists bot_order_requests_followup_idx
  on bot_order_requests(follow_up_at)
  where follow_up_sent_at is null;

create index if not exists bot_order_requests_plink_idx
  on bot_order_requests(razorpay_payment_link_id);
