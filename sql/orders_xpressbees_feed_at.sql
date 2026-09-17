-- "Push this order to the XpressBees panel", as pressed from the admin panel.
--
-- XpressBees does not accept a push. Its Sales Channel importer PULLS our
-- WooCommerce feed every few minutes, so the only way to put an order in front
-- of it is to make the order visible in that feed. The feed is deliberately
-- date-bounded (WOO_FEED_SINCE) so that only recent orders ship automatically.
-- This column is the deliberate exception: an order stamped here stays in the
-- feed regardless of its age, until it ships.
--
-- Nothing else reads it, and clearing it simply returns the order to the
-- normal date rule.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS xpressbees_feed_at timestamptz;

CREATE INDEX IF NOT EXISTS orders_xpressbees_feed_at_idx
  ON orders (xpressbees_feed_at)
  WHERE xpressbees_feed_at IS NOT NULL;
