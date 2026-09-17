-- Fire-once marker for the "your order has shipped" notification.
--
-- The XpressBees push-back notifies on the TRANSITION into shipped, so it is
-- already self-limiting. This column exists for the backfill path
-- (admin-resend-shipped), where the transition has long since happened and the
-- only thing standing between a customer and a duplicate message is a marker.
--
-- Claimed with `.is('shipped_notified_at', null)` so two concurrent runs
-- cannot both win, and cleared again if the send failed outright -- a customer
-- who was never reached must not be recorded as notified.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_notified_at timestamptz;

CREATE INDEX IF NOT EXISTS orders_shipped_notified_at_idx
  ON orders (shipped_notified_at)
  WHERE shipped_notified_at IS NULL;
