-- Prepaid cancellation after the 30-minute window (utils/prepaid-late-cancel.js).
-- refund_amount_paise and cancellation_fee_paise already exist on orders.
alter table public.orders add column if not exists late_cancel_at    timestamptz;
alter table public.orders add column if not exists late_cancel_state text;
create index if not exists orders_late_cancel_state_idx
  on public.orders (late_cancel_state) where late_cancel_state is not null;
