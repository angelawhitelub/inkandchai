-- Run once in Supabase SQL editor: track PhonePe refund attempts so failed
-- refunds can be re-checked and automatically retried.
alter table orders add column if not exists refund_id       text;   -- our merchantRefundId
alter table orders add column if not exists refund_state    text;   -- PENDING | COMPLETED | FAILED
alter table orders add column if not exists refund_attempts int  default 0;
alter table orders add column if not exists refund_last_error text;
alter table orders add column if not exists refund_updated_at timestamptz;
create index if not exists orders_refund_state_idx on orders(refund_state);

-- Dedup guard for "refund initiated" customer notifications (email + WhatsApp).
-- Stamped by utils/refund-notifications.js the first time we tell a customer
-- their refund is on the way; subsequent PENDING → COMPLETED state changes on
-- the same refund won't re-notify them.
alter table orders add column if not exists refund_notified_at timestamptz;
