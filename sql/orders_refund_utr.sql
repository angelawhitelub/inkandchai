-- Refund UTR — the bank rail reference for a completed refund.
--
-- Run this once in Supabase → SQL Editor. Safe to re-run.
--
-- Why: the customer was being told to quote our own merchantRefundId
-- (REFUND-IC-20260726-RU6EE-A0) to their bank. That id exists only inside this
-- codebase — no bank can trace it. The UTR (e.g. 620779703346) is the reference
-- the money actually moved under, and it is what PhonePe's dashboard shows next
-- to the refund.
--
-- PhonePe returns it under paymentDetails[].rail.utr on the refund STATUS call,
-- never on the refund POST — it only exists once the money has moved. Razorpay
-- exposes the equivalent as acquirer_data.utr / rrn / arn, usually only after
-- the refund settles.
--
-- Nothing breaks without this column: every writer drops it and retries when
-- Postgres says it is missing, and refund messages fall back to the gateway
-- refund id. Running it just makes those messages traceable.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_utr text;

COMMENT ON COLUMN orders.refund_utr IS
  'Bank rail reference (UTR/RRN/ARN) for the completed refund. Quoted to the customer so their bank can trace it. Populated by phonepe-refund, razorpay-refund and the hourly refund reconcile.';

-- Refund lookups by state are how the reconcile job finds stuck refunds.
CREATE INDEX IF NOT EXISTS idx_orders_refund_state_status
  ON orders (status, refund_state)
  WHERE status IN ('refund_pending', 'refund_failed', 'refunded', 'partially_refunded');
