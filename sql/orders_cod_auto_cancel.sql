-- Tracks AWB assignment separately from real courier movement so stale COD
-- shipments can be cancelled safely. Run before deploying the matching code.
alter table orders add column if not exists awb_assigned_at timestamptz;
alter table orders add column if not exists shipment_moved_at timestamptz;
alter table orders add column if not exists shipment_payment_type text;
alter table orders add column if not exists last_nimbuspost_status text;
alter table orders add column if not exists last_nimbuspost_event_at timestamptz;
alter table orders add column if not exists auto_cancel_claimed_at timestamptz;
alter table orders add column if not exists auto_cancelled_at timestamptz;
alter table orders add column if not exists auto_cancel_last_error_at timestamptz;
alter table orders add column if not exists auto_cancel_last_error text;
alter table orders add column if not exists cancellation_source text;
alter table orders add column if not exists cancellation_reason text;

create index if not exists orders_stale_cod_awb_idx
  on orders (awb_assigned_at)
  where status = 'shipped'
    and shipment_moved_at is null
    and auto_cancelled_at is null;

