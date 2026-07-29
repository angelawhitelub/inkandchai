create table if not exists public.product_shipping_rules (
  slug text primary key,
  excluded_states jsonb not null default '[]'::jsonb,
  excluded_pincodes jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  constraint product_shipping_rules_states_array check (jsonb_typeof(excluded_states) = 'array'),
  constraint product_shipping_rules_pincodes_array check (jsonb_typeof(excluded_pincodes) = 'array')
);

alter table public.product_shipping_rules enable row level security;

create index if not exists product_shipping_rules_updated_idx
  on public.product_shipping_rules (updated_at desc);
