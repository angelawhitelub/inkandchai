-- Run once in Supabase SQL editor. Backs the admin "Bot Instructions" tab —
-- one row (id=1) holding extra instructions appended to the WhatsApp bot's
-- system prompt at runtime (no deploy needed to tune bot behaviour).
create table if not exists bot_settings (
  id int primary key default 1,
  extra_instructions text default '',
  updated_at timestamptz default now()
);
insert into bot_settings (id, extra_instructions) values (1, '')
  on conflict (id) do nothing;
