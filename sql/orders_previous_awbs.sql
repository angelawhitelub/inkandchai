-- Audit trail of AWBs an order has carried before its current one.
--
-- When a courier cancels a shipment and the order is re-shipped in the
-- NimbusPost panel, the AWB sync moves the order onto the new AWB. Without
-- this column the old one is simply overwritten and there is no way to answer
-- "what happened to the first shipment?".
--
-- Optional: nimbuspost-awb-sync-background drops this field and still writes
-- the rest if the column is missing.
alter table orders add column if not exists previous_tracking_ids text;
