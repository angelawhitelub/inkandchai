-- Neon Postgres: standby copy of every order.
--
-- Run this once in the Neon SQL editor (or psql) against the project you
-- created for Ink & Chai. It is safe to re-run.
--
-- Why this exists: on 24 Aug 2026 the Supabase project stopped resolving for
-- eight hours. Twelve paid orders were taken with no row written anywhere, and
-- the cart and address on them were never recoverable. Orders are now written
-- to a Netlify Blobs store AND to this table, so a copy survives Supabase being
-- paused, deleted, or restored to an older snapshot — and unlike the blob store
-- this one can be queried with SQL.
--
-- Column names and types mirror the Supabase `orders` table so a row can be
-- copied back without translation.

CREATE TABLE IF NOT EXISTS orders_mirror (
  razorpay_order_id    TEXT PRIMARY KEY,
  razorpay_payment_id  TEXT,
  amount_paise         BIGINT,
  status               TEXT,
  customer_name        TEXT,
  customer_email       TEXT,
  customer_phone       TEXT,
  customer_address     TEXT,
  cart_items           JSONB,
  user_id              TEXT,
  order_created_at     TIMESTAMPTZ,          -- created_at as the storefront meant it
  source               TEXT,                 -- which function wrote this copy
  mirrored_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A deliberate admin deletion. The reconcile skips these, so a deleted order
  -- is never resurrected; a missing row and a deleted one are otherwise
  -- indistinguishable.
  deleted_at           TIMESTAMPTZ,
  deleted_reason       TEXT
);

CREATE INDEX IF NOT EXISTS orders_mirror_mirrored_at_idx
  ON orders_mirror (mirrored_at DESC);

-- The reconcile scans recent, live rows; this keeps that scan off the heap.
CREATE INDEX IF NOT EXISTS orders_mirror_live_idx
  ON orders_mirror (mirrored_at DESC)
  WHERE deleted_at IS NULL;
