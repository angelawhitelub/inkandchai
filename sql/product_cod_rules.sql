-- Run once in Supabase SQL editor.
-- Cash on Delivery switched off for individual books (catalogue or admin-
-- created), set from the admin product editor. A row means COD is off for that
-- slug; `note` is what the customer reads on the product page and at checkout
-- (blank = the default "brought from the publisher on demand" message).
-- Partial COD (pay 10% now) and full prepaid stay available.
create table if not exists product_cod_rules (
  slug        text primary key,
  note        text,
  updated_at  timestamptz not null default now()
);

alter table product_cod_rules enable row level security;

-- Only the service-role functions read or write it.
revoke all on table product_cod_rules from anon, authenticated;
