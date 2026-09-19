-- What the COURIER last said about a shipment, kept beside what our books say.
--
-- last_nimbuspost_status already does this for NimbusPost-fed shipments, but
-- XpressBees is polled, not pushed (xpressbees-status-sync-background.js), and
-- filing its text under a NimbusPost column would make the source of every
-- status unreadable a month from now.
--
-- These columns never drive a decision. They exist so that when the courier
-- and the order disagree -- an exception scan, an RTO on a refunded order, a
-- cancelled panel row -- the courier's view is on the record instead of lost.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_courier_status     text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_courier_status_at  timestamptz;

CREATE INDEX IF NOT EXISTS orders_last_courier_status_at_idx
  ON orders (last_courier_status_at)
  WHERE last_courier_status_at IS NOT NULL;
