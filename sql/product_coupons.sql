create table if not exists public.product_coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{3,32}$'),
  label text not null,
  discount_type text not null check (discount_type in ('percent', 'fixed')),
  discount_value numeric(10,2) not null check (discount_value > 0),
  min_subtotal_inr numeric(10,2) not null default 0 check (min_subtotal_inr >= 0),
  product_slugs text[] not null,
  online_only boolean not null default true,
  is_active boolean not null default true,
  starts_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(product_slugs) > 0),
  check (discount_type <> 'percent' or discount_value <= 100)
);

create index if not exists product_coupons_active_idx on public.product_coupons (is_active);
create index if not exists product_coupons_products_gin_idx on public.product_coupons using gin (product_slugs);
alter table public.product_coupons enable row level security;

insert into public.product_coupons
  (code, label, discount_type, discount_value, min_subtotal_inr, product_slugs, online_only, is_active)
values
  ('NETFLIX10', 'Special 10% off for Netflix series', 'percent', 10, 0,
   array['musafir-cafe-divya-prakash-dubey-prerna-singh'], true, true)
on conflict (code) do update set
  label = excluded.label,
  discount_type = excluded.discount_type,
  discount_value = excluded.discount_value,
  product_slugs = excluded.product_slugs,
  online_only = excluded.online_only,
  is_active = excluded.is_active,
  updated_at = now();
