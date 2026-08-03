-- Gmail auto-acknowledgement integration. Run once in Supabase SQL Editor.
create table if not exists public.gmail_integrations (
  id text primary key,
  email text,
  refresh_token_encrypted text not null,
  history_id text,
  watch_expiration timestamptz,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
create table if not exists public.gmail_auto_replies (
  message_id text primary key,
  thread_id text,
  from_email text not null,
  status text not null default 'sending',
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.gmail_integrations enable row level security;
alter table public.gmail_auto_replies enable row level security;
