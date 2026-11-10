-- Copyright reports from the public /copyright/ form (copyright-report function).
-- Written only with the service key; RLS on with no policies keeps it private.
create table if not exists public.copyright_reports (
  id               bigserial primary key,
  ref              text not null unique,
  created_at       timestamptz not null default now(),
  status           text not null default 'new',      -- new / reviewing / removed / rejected
  product_url      text not null,
  product_slug     text not null,
  reporter_name    text not null,
  reporter_email   text not null,
  reporter_phone   text,
  organisation     text,
  role             text not null,                     -- owner / agent
  work_description text not null,
  original_url     text,
  details          text not null,
  good_faith       boolean not null default false,
  accurate         boolean not null default false,
  signature        text not null,
  image_keys       jsonb not null default '[]'::jsonb, -- private R2 keys, copyright/<ref>/<n>.<ext>
  image_count      int not null default 0,
  source_ip_hash   text,
  user_agent       text,
  owner_notes      text
);
create index if not exists copyright_reports_created_idx on public.copyright_reports (created_at desc);
create index if not exists copyright_reports_ip_idx on public.copyright_reports (source_ip_hash, created_at);
create index if not exists copyright_reports_slug_idx on public.copyright_reports (product_slug);
alter table public.copyright_reports enable row level security;
