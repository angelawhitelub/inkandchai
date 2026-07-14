-- Run once in Supabase SQL Editor before deploying the matching code.
-- One webhook handles multiple Ink & Chai WhatsApp business numbers. This
-- records which number received each conversation so a human reply is sent
-- from that same number rather than opening/using a different WhatsApp chat.

alter table public.bot_conversations
  add column if not exists whatsapp_phone_id text;

comment on column public.bot_conversations.whatsapp_phone_id is
  'Meta Cloud API phone_number_id that received the latest inbound message';
