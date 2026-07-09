-- ────────────────────────────────────────────────────────────────────────────
-- READ-ONLY AUDIT: Razorpay orders cancelled but never refunded.
--
-- Surfaces every prepaid Razorpay order that was cancelled via a path that
-- (before the e294c50383 fix) skipped the auto-refund — i.e. bulk-update or the
-- NimbusPost courier webhook. These customers are owed a refund you must issue
-- MANUALLY in the Razorpay Dashboard (Transactions → paste payment_id → Refund).
--
-- Safe to run anytime — this only SELECTs, it never modifies data.
-- ────────────────────────────────────────────────────────────────────────────

select
  razorpay_order_id                      as order_id,
  razorpay_payment_id                    as razorpay_payment_id,   -- paste this in the Razorpay Dashboard
  customer_name,
  customer_email,
  customer_phone,
  round(amount_paise / 100.0, 2)         as amount_rs,
  status,
  tracking_id,
  courier_name,
  created_at
from orders
where status = 'cancelled'                       -- cancelled, NOT already refunded/refund_pending/refunded
  and razorpay_payment_id is not null
  and razorpay_payment_id like 'pay_%'            -- Razorpay only (PhonePe uses a different id shape)
  and coalesce(amount_paise, 0) > 0               -- money was actually captured
  and coalesce(source, '') <> 'paperbound'        -- exclude the other store
order by created_at desc;

-- ── Quick total owed (run separately if you want the headline number) ─────────
-- select
--   count(*)                          as unrefunded_orders,
--   round(sum(amount_paise) / 100.0, 2) as total_owed_rs
-- from orders
-- where status = 'cancelled'
--   and razorpay_payment_id like 'pay_%'
--   and coalesce(amount_paise, 0) > 0
--   and coalesce(source, '') <> 'paperbound';
