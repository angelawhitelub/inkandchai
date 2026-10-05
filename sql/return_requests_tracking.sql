-- Reverse-pickup tracking for customer returns (return-tracking-scheduled.js).
-- Safe to run more than once. Until it is run the hourly job still backfills
-- AWBs, but tracking is only shown live in the admin and no "received" alert
-- is sent (it needs delivered_alerted_at to send it only once).
alter table return_requests add column if not exists tracking_status       text;
alter table return_requests add column if not exists tracking_last_scan    text;
alter table return_requests add column if not exists tracking_last_scan_at timestamptz;
alter table return_requests add column if not exists tracking_checked_at   timestamptz;
alter table return_requests add column if not exists tracking_events       jsonb;
alter table return_requests add column if not exists return_delivered_at   timestamptz;
alter table return_requests add column if not exists delivered_alerted_at  timestamptz;
