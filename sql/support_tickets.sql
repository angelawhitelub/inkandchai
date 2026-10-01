-- Run once in Supabase SQL editor.
-- Customer support tickets raised from inkandchai.in/support/.
--
-- support_tickets        one row per ticket
-- support_ticket_events  the conversation + audit trail (customer messages,
--                        staff replies, internal notes, status changes, delay notices)
--
-- Evidence files live in the PRIVATE R2 bucket (support/<ticket_no>/...) and are
-- listed on the ticket / event as {key, name, type, size}. The browser never
-- reads either table; the service-role functions do.

create table if not exists support_tickets (
  id                 uuid primary key default gen_random_uuid(),
  ticket_no          text not null unique,
  order_id           text not null,                 -- orders.razorpay_order_id (IC-…), mandatory
  customer_name      text,
  customer_email     text,
  customer_phone     text,
  category           text not null,
  priority           text not null default 'normal' check (priority in ('normal','high')),
  subject            text,
  message            text not null,
  evidence           jsonb not null default '[]'::jsonb,
  status             text not null default 'open'
                       check (status in ('open','in_progress','waiting_customer','closed')),
  resolution         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  respond_by         timestamptz not null,          -- created_at + 24 h
  due_at             timestamptz not null,          -- created_at + 48 h (reset on reopen)
  first_response_at  timestamptz,
  closed_at          timestamptz,
  reopened_count     smallint not null default 0,
  delay_notices      smallint not null default 0,   -- "taking longer than expected" emails sent
  delay_notified_at  timestamptz,
  owner_reminded_at  timestamptz,                   -- the 24 h "nobody has answered" nudge
  last_customer_at   timestamptz,
  last_staff_at      timestamptz,
  source_ip_hash     text
);

create index if not exists support_tickets_status_due_idx on support_tickets (status, due_at);
create index if not exists support_tickets_order_idx on support_tickets (order_id);
create index if not exists support_tickets_created_idx on support_tickets (created_at desc);

create table if not exists support_ticket_events (
  id          bigint generated always as identity primary key,
  ticket_id   uuid not null references support_tickets(id) on delete cascade,
  actor       text not null check (actor in ('customer','staff','system')),
  kind        text not null check (kind in ('message','note','status','delay','created')),
  body        text,
  attachments jsonb not null default '[]'::jsonb,
  internal    boolean not null default false,       -- true = never shown to the customer
  created_at  timestamptz not null default now()
);

create index if not exists support_ticket_events_ticket_idx on support_ticket_events (ticket_id, created_at);

alter table support_tickets enable row level security;
alter table support_ticket_events enable row level security;
revoke all on table support_tickets from anon, authenticated;
revoke all on table support_ticket_events from anon, authenticated;
