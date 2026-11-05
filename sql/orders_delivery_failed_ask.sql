-- Delivery-failed WhatsApp question (netlify/functions/utils/delivery-failed-ask.js).
-- Run ONCE, when the template is approved: the last statement marks every order
-- already failed at that moment so the job does not message that backlog.
alter table orders add column if not exists delivery_failed_asked_at    timestamptz;
alter table orders add column if not exists delivery_failed_state       text;
alter table orders add column if not exists delivery_failed_choice      text;
alter table orders add column if not exists delivery_failed_reason      text;
alter table orders add column if not exists delivery_failed_alt_phone   text;
alter table orders add column if not exists delivery_failed_answered_at timestamptz;
create index if not exists orders_delivery_failed_open_idx on orders (delivery_failed_state)
  where delivery_failed_state in ('asked', 'reason', 'number');

update orders
   set delivery_failed_asked_at = now(), delivery_failed_state = 'backlog'
 where status in ('shipped', 'out_for_delivery')
   and delivery_failed_asked_at is null
   and last_courier_status ~* '(exception|undelivered|ndr|failed)'
   and last_courier_status !~* '^lookup failed';
