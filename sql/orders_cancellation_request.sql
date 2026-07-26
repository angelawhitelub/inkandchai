-- Customer-initiated cancellation REQUEST (not a cancellation).
--
-- Distinct from the existing instant-cancel paths (COD before pickup, prepaid
-- within 30 min) which set status='cancelled' directly. A "request" is only a
-- flag + note: it NEVER changes status, refunds, or cancels the courier shipment.
-- The store owner reviews it and acts manually. See netlify/functions/request-cancellation.js.
alter table orders add column if not exists cancellation_requested_at timestamptz;
alter table orders add column if not exists cancellation_request_note text;

-- Optional: quickly list pending requests in the admin.
create index if not exists orders_cancellation_requested_idx
  on orders (cancellation_requested_at)
  where cancellation_requested_at is not null;
