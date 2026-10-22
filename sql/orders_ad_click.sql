-- Whether checkout saw a Google Ads click (gclid:/gbraid:/wbraid:… or 'none').
-- The Google Ads retraction feed skips 'none'; null (older orders) is still retracted.
alter table public.orders add column if not exists ad_click text;
