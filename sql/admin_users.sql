-- Limited admin accounts. Run once in Supabase SQL Editor.
create table if not exists public.admin_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  role text not null default 'support' check (role in ('support')),
  password_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;
-- Netlify uses the service key server-side; no browser policy is needed.
