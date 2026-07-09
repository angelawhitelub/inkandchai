-- Deterministic dedup for NimbusPost pushes.
-- Once an order is pushed to the NP panel we stamp this timestamp, and the
-- push endpoint skips any order that already has it — so an order can never be
-- pushed twice regardless of how old it is (NimbusPost does NOT enforce unique
-- order numbers, and our panel scan only covers the ~500 newest orders).
-- Safe to run multiple times.
alter table orders
  add column if not exists nimbus_pushed_at timestamptz;

create index if not exists orders_nimbus_pushed_at_idx
  on orders(nimbus_pushed_at);
