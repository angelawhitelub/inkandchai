-- Run once in Supabase SQL editor (added 2026-10-02).
-- A customer can have only one unresolved ticket per order until it is closed.
-- The app checks this too; the index stops two simultaneous submissions both
-- getting through. Safe to run twice.
create unique index if not exists support_tickets_one_open_per_order
  on support_tickets (order_id) where status <> 'closed';
