-- Run once in Supabase SQL editor.
-- Single-row table holding the admin-editable WhatsApp bot instructions/FAQ.
create table if not exists bot_settings (
  id                 int primary key default 1,
  extra_instructions text default '',
  updated_at         timestamptz default now()
);
insert into bot_settings (id, extra_instructions)
  values (1, '') on conflict (id) do nothing;
