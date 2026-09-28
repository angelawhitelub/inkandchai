-- XpressBees courier-cancel handler (utils/courier-cancelled.js).
-- When XpressBees first reports an order's AWB cancelled, the time and the AWB
-- are stamped here; the order is cancelled + refunded only after a grace
-- period, and only if that AWB is still the order's shipment.
alter table public.orders add column if not exists courier_cancelled_at  timestamptz;
alter table public.orders add column if not exists courier_cancelled_awb text;
