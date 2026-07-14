-- One-time "your order is in transit" customer notification dedup.
-- NimbusPost sends many "in transit" hub-scan events per shipment; the webhook
-- fires the in-transit email + WhatsApp exactly once by atomically claiming this
-- timestamp (update ... where in_transit_notified_at is null). Until this column
-- exists the webhook SKIPS in-transit notifications (fails safe, no spam), so run
-- this before relying on the in-transit alert.
-- Safe to run multiple times.

alter table orders
  add column if not exists in_transit_notified_at timestamptz;
