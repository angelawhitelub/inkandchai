-- Replacement shipments are fulfilment corrections, never COD sales.
-- Backfill legacy rows so every shipping path has an explicit source of truth.

alter table orders add column if not exists shipment_payment_type text;

update orders
set shipment_payment_type = 'prepaid'
where (
  lower(coalesce(source, '')) = 'replacement'
  or coalesce(razorpay_order_id, '') ~* '^IC-R-'
  or coalesce(cart_items, '[]'::jsonb) @> '[{"_replacement": {}}]'::jsonb
)
and shipment_payment_type is distinct from 'prepaid';

-- Restore unshipped replacements that were accidentally passed through a
-- generic payment/status control. This also restores Edit books / Refund
-- instead actions in the Replacements panel.
update orders
set status = 'replacement_pending'
where (
  lower(coalesce(source, '')) = 'replacement'
  or coalesce(razorpay_order_id, '') ~* '^IC-R-'
  or coalesce(cart_items, '[]'::jsonb) @> '[{"_replacement": {}}]'::jsonb
)
and lower(coalesce(status, '')) in ('paid', 'confirmed', 'cod_pending', 'partial_cod_pending')
and tracking_id is null;
