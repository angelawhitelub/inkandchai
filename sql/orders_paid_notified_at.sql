-- One "payment received" notification per order.
--
-- The PhonePe webhook and phonepe-verify-status both confirm the same payment
-- on purpose (either can go missing), and both used to notify. Their guard was
-- a read-then-write on status, which does nothing when they run in the same
-- second -- one order sent two owner emails at 12:10 AM.
--
-- This column is claimed with a single conditional UPDATE, so Postgres picks
-- the winner and the loser stays quiet.
--
-- Optional: utils/paid-notify-once falls back to claiming the status
-- transition itself when this column is missing. Run it to close the race
-- completely.
alter table orders add column if not exists paid_notified_at timestamptz;

-- Orders already paid must not be re-notified if a webhook is replayed.
update orders set paid_notified_at = coalesce(shipped_at, created_at)
where paid_notified_at is null
  and status not in ('pending_phonepe', 'pending_partial_phonepe', 'created', 'pending');
