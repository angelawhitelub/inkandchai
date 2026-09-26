-- Ink AI: customer star ratings for a chat, one row per chat session.
-- The widget re-posts when a customer changes their rating or adds a comment,
-- so session_id is unique and the endpoint upserts on it.
create table if not exists public.ink_ai_feedback (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  session_id  text not null unique,
  rating      smallint not null check (rating between 1 and 5),
  comment     text,
  page_url    text,
  turns       int
);
create index if not exists ink_ai_feedback_created_idx on public.ink_ai_feedback (created_at desc);
create index if not exists ink_ai_feedback_rating_idx  on public.ink_ai_feedback (rating);
-- Service key only: customers write through the endpoint, never directly.
alter table public.ink_ai_feedback enable row level security;

-- Lets the admin panel open the whole chat behind a rating.
create index if not exists ink_ai_conversations_session_idx on public.ink_ai_conversations (session_id);
