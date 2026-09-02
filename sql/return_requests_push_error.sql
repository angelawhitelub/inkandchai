-- Record why a NimbusPost reverse-pickup push failed, and whether the customer
-- has already been told their return is approved.
--
-- Optional: process-return.js drops these fields and still writes the rest if
-- they are missing, so the code works before this runs. Without them the panel
-- cannot show the failure reason, and the approved notification is sent again
-- on every retry.
alter table return_requests add column if not exists last_push_error text;
alter table return_requests add column if not exists last_push_error_at timestamptz;
alter table return_requests add column if not exists approved_notified_at timestamptz;
