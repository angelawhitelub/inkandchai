-- Run once in the Supabase SQL editor.
--
-- 1) refund_items — WHICH books a partial refund covered.
--    The admin's refund modal lets you tick individual titles. Without this
--    column the customer's email and WhatsApp can only quote an amount ("₹239
--    refunded" against a ₹592 order with three books), and PhonePe partials that
--    come back PENDING are confirmed hours later by the retry job, which has no
--    access to the original request.
--    Shape: [{"title": "...", "qty": 1, "amount": 239}, ...]
alter table orders add column if not exists refund_items jsonb;

-- 2) refund_notified_at — re-asserted here on purpose.
--    It is declared at the end of sql/refund_tracking.sql, but that line was
--    added after the file was first run and this database does not have the
--    column. utils/refund-notifications.js reads it as its "did we already tell
--    this customer?" guard and writes it inside a try/catch, so the failure is
--    silent: the guard is currently inert, and a refund whose state flips
--    PENDING → COMPLETED can notify the same customer more than once.
--    `if not exists` makes this safe to run even where it already applied.
alter table orders add column if not exists refund_notified_at timestamptz;
