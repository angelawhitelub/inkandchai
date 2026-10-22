-- "Report a problem" from the website (admin → 🐞 Bug reports). Safe to run more than once.
create table if not exists public.bug_reports (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  message     text not null,
  contact     text,
  page_url    text,
  device      text,
  viewport    text,
  user_agent  text,
  cart        jsonb,
  errors      jsonb,
  visitor_id  text,
  status      text not null default 'new' check (status in ('new', 'looking', 'fixed', 'closed')),
  admin_note  text
);
create index if not exists bug_reports_created_idx on public.bug_reports (created_at desc);
create index if not exists bug_reports_status_idx on public.bug_reports (status, created_at desc);
alter table public.bug_reports enable row level security;
